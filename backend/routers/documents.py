from __future__ import annotations

import os
import re
import json
import time
import uuid
import shutil
import logging
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, BackgroundTasks
from pydantic import BaseModel
from sqlalchemy import or_, func
from sqlalchemy.orm import Session
from typing import Optional
from backend.db import get_db, SessionLocal
from backend.models import (
    TopicTree, Section, Upload, ProcessingJob, JobStatus,
    ContentBlock, SectionImage, Curriculum, Card, slugify, utcnow,
)
from backend.config import UPLOAD_DIR, SCAN_DIR

logger = logging.getLogger(__name__)

router = APIRouter()


def _merge_flag(existing, flag):
    """Add ``flag`` to a section's JSON flags list (idempotent). Returns the new
    list, or None when empty so the column stays clean."""
    flags = list(existing or [])
    if flag and flag not in flags:
        flags.append(flag)
    return flags or None


def _normalize_for_match(s: str) -> str:
    """Normalize string for fuzzy curriculum matching."""
    s = s.lower().strip()
    s = re.sub(r'\s*/\s*', '/', s)
    s = re.sub(r'\s+', ' ', s)
    return s


def _match_section_to_curriculum(
    db: Session,
    heading: str,
    parent_curriculum_id: Optional[int],
) -> tuple[Optional[int], Optional[str]]:
    """Try to match a section heading to a specific curriculum leaf node.

    Searches within the subtree of parent_curriculum_id for a node whose name
    matches the heading (case-insensitive, with normalized whitespace/slashes).
    Falls back to the parent node if no match is found.

    Returns (curriculum_topic_id, curriculum_topic_path).
    """
    if not parent_curriculum_id:
        return None, None

    parent = db.get(Curriculum, parent_curriculum_id)
    if not parent:
        return None, None

    norm_heading = _normalize_for_match(heading)

    candidates = (
        db.query(Curriculum)
        .filter(
            Curriculum.version == parent.version,
            Curriculum.path.startswith(parent.path),
        )
        .all()
    )

    for node in candidates:
        if _normalize_for_match(node.name) == norm_heading:
            return node.id, node.path

    # Fallback: use the parent node itself
    return parent.id, parent.path


def topic_tree_to_dict(tt: TopicTree, include_sections: bool = True) -> dict:
    d = {
        "id": tt.id,
        "name": tt.name,
        "slug": tt.slug,
        "curriculum_id": tt.curriculum_id,
        "created_at": tt.created_at.isoformat() if tt.created_at else None,
        "section_count": len(tt.sections) if tt.sections else 0,
        "upload_count": len(tt.uploads) if tt.uploads else 0,
        "total_cards": sum(len(s.cards) for s in tt.sections) if tt.sections else 0,
    }
    if include_sections:
        d["sections"] = [section_to_dict(s, include_content=False) for s in sorted(tt.sections, key=lambda s: s.sort_order)]
    return d


def section_to_dict(s: Section, include_content: bool = True) -> dict:
    d = {
        "id": s.id,
        "topic_tree_id": s.topic_tree_id,
        "heading": s.heading,
        "slug": s.slug,
        "heading_tree": s.heading_tree,
        "curriculum_topic_id": s.curriculum_topic_id,
        "curriculum_topic_path": s.curriculum_topic_path,
        "image_count": s.image_count,
        "table_count": s.table_count,
        "flags": s.flags,
        "is_verified": s.is_verified,
        "sort_order": s.sort_order,
        "section_status": s.section_status,
        "card_count": len(s.cards) if s.cards else 0,
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "updated_at": s.updated_at.isoformat() if s.updated_at else None,
    }
    if include_content:
        d["content_text"] = s.content_text
        d["content_html"] = s.content_html
    return d


class ContinueRequest(BaseModel):
    scan_token: str
    included_hids: list[int] = []


@router.post("/continue")
def continue_processing(
    body: ContinueRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Commit an ephemeral scan: create user-selected new curriculum nodes,
    re-align, create the topic-tree/upload/job, and kick off processing."""
    token = body.scan_token
    json_path = os.path.join(SCAN_DIR, token + ".json")
    docx_path = os.path.join(SCAN_DIR, token + ".docx")
    if not os.path.exists(docx_path):
        raise HTTPException(404, "Scan expired — please re-upload")

    # Consume the token atomically: the rename succeeds for exactly one caller,
    # making a double-submit of the same scan a clean 409 instead of duplicate
    # curriculum nodes / uploads.
    consumed_path = json_path + ".consumed"
    try:
        os.rename(json_path, consumed_path)
    except OSError:
        if os.path.exists(consumed_path):
            raise HTTPException(409, "Scan already being processed")
        raise HTTPException(404, "Scan expired — please re-upload")

    try:
        return _continue_processing_inner(consumed_path, docx_path, body, background_tasks, db)
    except Exception:
        # Restore the token so the scan stays retryable after a failure.
        try:
            os.rename(consumed_path, json_path)
        except OSError:
            pass
        raise


def _continue_processing_inner(
    consumed_path: str,
    docx_path: str,
    body: ContinueRequest,
    background_tasks: BackgroundTasks,
    db: Session,
):
    from backend.services.curriculum_aligner import align, expand_includes

    with open(consumed_path) as f:
        sidecar = json.load(f)
    outline = sidecar["outline"]

    main = db.get(Curriculum, sidecar["main_topic_id"])
    if not main:
        raise HTTPException(404, "Main curriculum topic not found")

    # Validate the topic-tree name/slug BEFORE minting curriculum nodes, so a
    # 409 collision doesn't leave freshly-minted nodes behind.
    new_tree_name: Optional[str] = None
    new_tree_slug: Optional[str] = None
    if not sidecar.get("topic_tree_id"):
        new_tree_name = sidecar.get("topic_tree_name") or os.path.splitext(sidecar["original_name"])[0]
        new_tree_slug = slugify(new_tree_name)
        existing = db.query(TopicTree).filter_by(slug=new_tree_slug).first()
        if existing:
            raise HTTPException(
                409,
                f"A topic tree named '{existing.name}' already exists. "
                f"Upload into it by selecting it, or use a different name."
            )

    def _load_subtree() -> list[dict]:
        subtree = db.query(Curriculum).filter(
            Curriculum.version == main.version,
            or_(Curriculum.id == main.id, Curriculum.path.startswith(main.path + " > ")),
        ).all()
        return [
            {"id": n.id, "parent_id": n.parent_id, "name": n.name, "level": n.level, "path": n.path}
            for n in subtree
        ]

    main_dict = {
        "id": main.id, "parent_id": main.parent_id, "name": main.name,
        "level": main.level, "path": main.path,
    }

    nodes = _load_subtree()
    resolution = align(outline, main_dict, nodes)["resolution"]

    # Create the user-selected new nodes, parents-first.
    ordered = expand_includes(body.included_hids, outline)

    parent_of: dict[int, Optional[int]] = {}
    text_of: dict[int, str] = {}

    def _walk(heading_nodes, parent_hid):
        for h in heading_nodes:
            parent_of[h["hid"]] = parent_hid
            text_of[h["hid"]] = h["text"]
            _walk(h["children"], h["hid"])

    _walk(outline, None)

    minted: dict[int, int] = {}
    for hid in ordered:
        if resolution.get(hid) is not None:
            continue  # already an existing curriculum node
        parent_hid = parent_of.get(hid)
        if parent_hid is None:
            parent = main
        elif resolution.get(parent_hid) is not None:
            parent = db.get(Curriculum, resolution[parent_hid])
        else:
            parent = db.get(Curriculum, minted[parent_hid])

        max_order = db.query(func.max(Curriculum.sort_order)).filter_by(
            parent_id=parent.id, version=parent.version).scalar() or 0
        node = Curriculum(
            name=text_of[hid], parent_id=parent.id, level=parent.level + 1,
            path=f"{parent.path} > {text_of[hid]}", sort_order=max_order + 1,
            version=parent.version,
        )
        db.add(node)
        db.flush()
        minted[hid] = node.id

    db.commit()

    # Re-align against the refreshed subtree so newly-minted nodes are matched.
    refreshed_nodes = _load_subtree()
    resolution2 = align(outline, main_dict, refreshed_nodes)["resolution"]

    # Resolve or create the topic tree.
    if sidecar.get("topic_tree_id"):
        tt = db.get(TopicTree, sidecar["topic_tree_id"])
        if not tt:
            raise HTTPException(404, "Topic tree not found")
    else:
        # Slug collision was already checked before minting curriculum nodes.
        tt = TopicTree(name=new_tree_name, slug=new_tree_slug, curriculum_id=main.id)
        db.add(tt)
        db.flush()

    # Move temp docx into the permanent upload dir and create the DB rows.
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    stored_name = f"{uuid.uuid4().hex}_{sidecar['original_name']}"
    shutil.move(docx_path, os.path.join(UPLOAD_DIR, stored_name))

    upload = Upload(
        topic_tree_id=tt.id,
        original_name=sidecar["original_name"],
        filename=stored_name,
        status="processing",
    )
    db.add(upload)
    db.flush()

    job = ProcessingJob(upload_id=upload.id, status=JobStatus.pending)
    job.pipeline_step = "parsing"
    db.add(job)
    db.commit()

    # Best-effort cleanup of the consumed sidecar (docx already moved out of SCAN_DIR).
    try:
        os.remove(consumed_path)
    except OSError:
        pass

    background_tasks.add_task(_run_processing, job.id, resolution2)

    return {"processing_job_id": job.id, "topic_tree_id": tt.id}


@router.post("/paste")
def paste_document(
    body: dict,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Paste HTML content, creating or targeting a topic tree, then auto-process."""
    html = body.get("html", "")
    topic_tree_name = body.get("topic_tree_name") or body.get("name") or "Pasted Content"
    topic_tree_id = body.get("topic_tree_id")
    curriculum_id = body.get("curriculum_id")

    if not html.strip():
        raise HTTPException(400, "No HTML content provided")

    os.makedirs(UPLOAD_DIR, exist_ok=True)
    stored_name = f"{uuid.uuid4().hex}_paste.html"
    filepath = os.path.join(UPLOAD_DIR, stored_name)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(html)

    if topic_tree_id:
        tt = db.get(TopicTree, topic_tree_id)
        if not tt:
            raise HTTPException(404, "Topic tree not found")
    else:
        slug = slugify(topic_tree_name)
        existing = db.query(TopicTree).filter_by(slug=slug).first()
        if existing:
            slug = f"{slug}-{uuid.uuid4().hex[:6]}"
        tt = TopicTree(
            name=topic_tree_name,
            slug=slug,
            curriculum_id=curriculum_id,
        )
        db.add(tt)
        db.flush()

    upload = Upload(
        topic_tree_id=tt.id,
        original_name="pasted_content.html",
        filename=stored_name,
        status="processing",
    )
    db.add(upload)
    db.flush()

    # Auto-start processing
    job = ProcessingJob(upload_id=upload.id, status=JobStatus.pending)
    db.add(job)
    db.commit()
    db.refresh(upload)
    db.refresh(tt)

    background_tasks.add_task(_run_processing, job.id)

    return {
        "upload_id": upload.id,
        "processing_job_id": job.id,
        "topic_tree_id": tt.id,
        "topic_tree": topic_tree_to_dict(tt),
    }


@router.post("/scan")
async def scan_document(
    file: UploadFile = File(...),
    topic_tree_name: Optional[str] = Form(None),
    topic_tree_id: Optional[int] = Form(None),
    curriculum_id: Optional[int] = Form(None),
    db: Session = Depends(get_db),
):
    """Ephemeral scan of a .docx: parse headings, diff against curriculum, return
    a merged tree. Creates NO DB rows — state lives as a temp file + sidecar JSON
    keyed by scan_token. A later /continue step commits."""
    if not file.filename.endswith(".docx"):
        raise HTTPException(400, "Only .docx files are supported")

    # Resolve the main curriculum topic id + version.
    if topic_tree_id:
        tt = db.get(TopicTree, topic_tree_id)
        if not tt:
            raise HTTPException(404, "Topic tree not found")
        main_id = tt.curriculum_id
    else:
        main_id = curriculum_id

    if not main_id:
        raise HTTPException(400, "Pick a main curriculum topic for this upload")

    main = db.get(Curriculum, main_id)
    if not main:
        raise HTTPException(400, "Main curriculum topic not found")

    os.makedirs(SCAN_DIR, exist_ok=True)
    scan_token = uuid.uuid4().hex
    docx_path = os.path.join(SCAN_DIR, scan_token + ".docx")
    content = await file.read()
    with open(docx_path, "wb") as f:
        f.write(content)

    from backend.services.doc_processor import parse_docx, parse_heading_outline
    elements = parse_docx(docx_path)
    outline = parse_heading_outline(elements)

    # Restrict to the main topic + its descendants (same as _build_reconcile).
    subtree = db.query(Curriculum).filter(
        Curriculum.version == main.version,
        or_(Curriculum.id == main.id, Curriculum.path.startswith(main.path + " > ")),
    ).all()
    nodes = [
        {"id": n.id, "parent_id": n.parent_id, "name": n.name, "level": n.level, "path": n.path}
        for n in subtree
    ]
    main_dict = {
        "id": main.id, "parent_id": main.parent_id, "name": main.name,
        "level": main.level, "path": main.path,
    }

    from backend.services.curriculum_aligner import align, build_merged_tree
    result = align(outline, main_dict, nodes)
    tree = build_merged_tree(outline, main_dict, nodes, result)

    json_path = os.path.join(SCAN_DIR, scan_token + ".json")
    sidecar = {
        "outline": outline,
        "main_topic_id": main.id,
        "version": main.version,
        "topic_tree_id": topic_tree_id,
        "topic_tree_name": topic_tree_name,
        "original_name": file.filename,
        "created_at": utcnow().isoformat(),
    }
    with open(json_path, "w") as f:
        json.dump(sidecar, f)

    return {
        "scan_token": scan_token,
        "tree": tree,
        "summary": result["levels"],
        "fuzzy": result["fuzzy"],
        "main_topic": main_dict,
    }


@router.delete("/scan/{scan_token}", status_code=204)
def delete_scan(scan_token: str):
    for ext in (".docx", ".json"):
        p = os.path.join(SCAN_DIR, scan_token + ext)
        if os.path.exists(p):
            try:
                os.remove(p)
            except OSError:
                pass


@router.get("")
def list_topic_trees(db: Session = Depends(get_db)):
    """List all topic trees with section summaries."""
    trees = db.query(TopicTree).all()
    return [topic_tree_to_dict(tt) for tt in trees]


@router.get("/{topic_tree_id}")
def get_topic_tree(topic_tree_id: int, db: Session = Depends(get_db)):
    tt = db.get(TopicTree, topic_tree_id)
    if not tt:
        raise HTTPException(404, "Topic tree not found")
    return topic_tree_to_dict(tt)


@router.get("/{topic_tree_id}/sections/{section_id}")
def get_section_detail(topic_tree_id: int, section_id: int, db: Session = Depends(get_db)):
    section = db.get(Section, section_id)
    if not section or section.topic_tree_id != topic_tree_id:
        raise HTTPException(404, "Section not found")
    d = section_to_dict(section, include_content=True)
    d["content_blocks"] = [
        {
            "id": cb.id,
            "text": cb.text,
            "html": cb.html,
            "block_type": cb.block_type,
            "heading_context": cb.heading_context,
            "position": cb.position,
            "is_duplicate": cb.is_duplicate,
        }
        for cb in sorted(section.content_blocks, key=lambda b: b.position)
    ]
    d["images"] = [
        {
            "id": img.id,
            "data_uri": img.data_uri,
            "category": img.category,
            "extracted_text": img.extracted_text,
            "alt_text_hint": img.alt_text_hint,
            "intended_position": img.intended_position,
            "position": img.position,
        }
        for img in sorted(section.images, key=lambda i: i.position)
    ]
    return d


@router.post("/{topic_tree_id}/process")
def start_processing(
    topic_tree_id: int,
    background_tasks: BackgroundTasks,
    upload_id: Optional[int] = None,
    db: Session = Depends(get_db),
):
    """Start background processing of an upload into sections."""
    tt = db.get(TopicTree, topic_tree_id)
    if not tt:
        raise HTTPException(404, "Topic tree not found")

    if upload_id:
        upload = db.get(Upload, upload_id)
        if not upload or upload.topic_tree_id != topic_tree_id:
            raise HTTPException(404, "Upload not found")
        uploads = [upload]
    else:
        uploads = [u for u in tt.uploads if u.status == "processing"]

    if not uploads:
        raise HTTPException(400, "No uploads to process")

    jobs = []
    for upload in uploads:
        job = ProcessingJob(upload_id=upload.id, status=JobStatus.pending)
        db.add(job)
        db.flush()
        jobs.append({"job_id": job.id, "upload_id": upload.id})

    db.commit()

    for job_info in jobs:
        background_tasks.add_task(_run_processing, job_info["job_id"])

    return {"jobs": jobs}


@router.get("/processing-jobs/{job_id}")
def get_processing_status(job_id: int, db: Session = Depends(get_db)):
    job = db.get(ProcessingJob, job_id)
    if not job:
        raise HTTPException(404)
    return {
        "id": job.id,
        "upload_id": job.upload_id,
        "status": job.status,
        "pipeline_step": job.pipeline_step,
        "error_message": job.error_message,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }


@router.delete("/{topic_tree_id}", status_code=204)
def delete_topic_tree(topic_tree_id: int, db: Session = Depends(get_db)):
    tt = db.get(TopicTree, topic_tree_id)
    if not tt:
        raise HTTPException(404)
    db.delete(tt)
    db.commit()


@router.post("/{topic_tree_id}/ai-headings")
def ai_detect_headings(
    topic_tree_id: int,
    background_tasks: BackgroundTasks,
    curriculum_version: str = "v2",
    db: Session = Depends(get_db),
):
    """Re-process the latest upload using AI-detected headings.

    Use this when a document was uploaded without proper Word heading styles.
    Claude analyzes paragraph formatting to infer the heading hierarchy, then
    the document is re-processed with those headings injected.
    """
    tt = db.get(TopicTree, topic_tree_id)
    if not tt:
        raise HTTPException(404, "Topic tree not found")

    # Find the most recent .docx upload
    docx_uploads = [u for u in tt.uploads if u.filename.endswith(".docx")]
    if not docx_uploads:
        raise HTTPException(400, "No .docx uploads found for this topic tree. AI heading detection only works on Word documents.")

    upload = sorted(docx_uploads, key=lambda u: u.id, reverse=True)[0]
    filepath = os.path.join(UPLOAD_DIR, upload.filename)
    if not os.path.exists(filepath):
        raise HTTPException(400, "Upload file no longer exists on disk (was it cleared?). Please re-upload the document.")

    # Clear existing sections so re-processing starts fresh
    for section in list(tt.sections):
        db.delete(section)
    db.flush()

    job = ProcessingJob(upload_id=upload.id, status=JobStatus.pending)
    db.add(job)
    db.commit()
    db.refresh(job)

    background_tasks.add_task(_run_ai_heading_processing, job.id, curriculum_version)

    return {
        "processing_job_id": job.id,
        "upload_id": upload.id,
        "topic_tree_id": tt.id,
        "message": "AI heading detection started. This may take 15–60 seconds depending on document size.",
    }


def _parse_alt_text_hint(hint: Optional[str]) -> dict:
    """Parse an image alt text marking into structured intent.

    Base commands:
      EXTRACT   — AI extracts text from image; image is replaced by that text in section content
      REF       — keep image as a reference (no extraction); shown on card front or back

    Optional suffix guidance:
      EXTRACT:CHART  — hint to AI that it's a chart/graph
      EXTRACT:TABLE  — hint to AI that it's a table
      EXTRACT:TEXT   — hint to AI that it's a text screenshot
      REF:FRONT      — reference image placed on card front
      REF:BACK       — reference image placed on card back (default)

    No alt text → full AI classification, kept as SectionImage (decorative)

    Returns:
      {
        "command": "extract" | "ref" | None,  # None = no alt text
        "intended_position": str | None,       # "front" | "back" | None (REF only)
        "category_hint": str | None,           # hint passed to AI (EXTRACT only)
      }
    """
    if not hint or not hint.strip():
        return {"command": None, "intended_position": None, "category_hint": None}

    upper = hint.strip().upper()
    suffix = upper.split(":", 1)[1].strip() if ":" in upper else ""

    if upper.startswith("REF"):
        position = "front" if suffix == "FRONT" else "back"
        return {"command": "ref", "intended_position": position, "category_hint": None}

    if upper.startswith("EXTRACT"):
        hint_map = {"CHART": "chart", "TABLE": "table_image", "TEXT": "text screenshot"}
        category_hint = hint_map.get(suffix)
        return {"command": "extract", "intended_position": None, "category_hint": category_hint}

    # Unknown marking — treat as no alt text
    return {"command": None, "intended_position": None, "category_hint": None}


def _run_processing(job_id: int, resolution: dict | None = None):
    """Background task: process an upload into sections and content blocks.

    When ``resolution`` (hid -> curriculum node_id|None) is provided, sections are
    built by attaching content to curriculum nodes (reconcile-gated upload flow).
    When None, the legacy split-by-H2 path runs (used by /paste and ai-headings).
    """
    from backend.services.doc_processor import (
        parse_docx, parse_html, split_by_h2, build_heading_tree, build_content_html,
        attach_content_to_curriculum, DUP_COLLAPSED_FLAG, dup_collapsed_flag,
    )
    from backend.services.table_converter import convert_table_elements

    db = SessionLocal()
    try:
        job = db.get(ProcessingJob, job_id)
        job.status = JobStatus.running
        job.started_at = utcnow()
        job.pipeline_step = "parsing"
        db.commit()

        upload = db.get(Upload, job.upload_id)
        tt = db.get(TopicTree, upload.topic_tree_id)
        filepath = os.path.join(UPLOAD_DIR, upload.filename)

        # Step 1: Parse document
        if upload.filename.endswith(".html"):
            elements = parse_html(filepath)
        else:
            elements = parse_docx(filepath)

        # Step 2: Convert tables to text
        job.pipeline_step = "tables"
        db.commit()
        elements = convert_table_elements(elements)

        # Step 3: Build section groups.
        # When a resolution map is supplied, attach content to curriculum nodes;
        # otherwise fall back to legacy split-by-H2.
        job.pipeline_step = "splitting"
        db.commit()

        if resolution is not None:
            groups = attach_content_to_curriculum(
                elements, {int(k): v for k, v in resolution.items()}, tt.curriculum_id
            )

            # Step 4: Create sections and content blocks (curriculum-aligned).
            job.pipeline_step = "merging"
            db.commit()

            for idx, group in enumerate(groups):
                node = db.get(Curriculum, group["node_id"])
                elems = group["elements"]

                heading = node.name
                curriculum_topic_id = node.id
                curriculum_topic_path = node.path

                heading_tree = build_heading_tree(elems)
                content_html = build_content_html(elems)
                content_text = "\n".join(e["text"] for e in elems if e.get("text"))

                image_count = sum(1 for e in elems if e.get("type") == "image")
                table_count = sum(1 for e in elems if e.get("type") == "table")
                dup_flag = dup_collapsed_flag(elems)

                auto_status = "orange" if "NO INFORMATION IN ORIGINAL STUDY GUIDE" in content_text.upper() else "normal"
                existing = (
                    db.query(Section)
                    .filter_by(topic_tree_id=tt.id, curriculum_topic_id=node.id)
                    .first()
                )
                if existing:
                    # Merge into the existing section (mirrors the legacy branch):
                    # content is fully REPLACED by this upload, so old content
                    # blocks are stale; keep only images referenced by cards.
                    section = existing
                    db.query(ContentBlock).filter(ContentBlock.section_id == section.id).delete()
                    referenced_img_ids = {
                        r[0] for r in db.query(Card.ref_img_id)
                        .filter(Card.section_id == section.id, Card.ref_img_id.isnot(None)).all()
                    }
                    stale_imgs = db.query(SectionImage).filter(SectionImage.section_id == section.id).all()
                    for old_img in stale_imgs:
                        if old_img.id not in referenced_img_ids:
                            db.delete(old_img)
                    section.content_text = content_text
                    section.content_html = content_html
                    section.heading_tree = heading_tree
                    section.image_count = image_count + len(referenced_img_ids)
                    section.table_count = table_count
                    section.curriculum_topic_path = curriculum_topic_path
                    section.updated_at = utcnow()
                    if "NO INFORMATION IN ORIGINAL STUDY GUIDE" in content_text.upper():
                        section.section_status = "orange"
                    # Drop stale dup-collapsed flags before re-adding the fresh one.
                    kept = [f for f in (section.flags or []) if not str(f).startswith(DUP_COLLAPSED_FLAG)]
                    section.flags = _merge_flag(kept, dup_flag)
                else:
                    section = Section(
                        topic_tree_id=tt.id,
                        heading=heading,
                        slug=slugify(f"{node.id}-{node.name}"),
                        heading_tree=heading_tree,
                        content_text=content_text,
                        content_html=content_html,
                        image_count=image_count,
                        table_count=table_count,
                        sort_order=idx,
                        curriculum_topic_id=curriculum_topic_id,
                        curriculum_topic_path=curriculum_topic_path,
                        section_status=auto_status,
                        flags=[dup_flag] if dup_flag else None,
                    )
                    db.add(section)
                    db.flush()

                # Create content blocks
                position = 0
                for elem in elems:
                    block_type = elem.get("type", "paragraph")
                    if block_type == "image":
                        if elem.get("data_uri"):
                            img = SectionImage(
                                section_id=section.id,
                                upload_id=upload.id,
                                data_uri=elem["data_uri"],
                                alt_text_hint=elem.get("alt_text"),
                                position=position,
                            )
                            db.add(img)
                    else:
                        cb = ContentBlock(
                            section_id=section.id,
                            upload_id=upload.id,
                            text=elem.get("text", ""),
                            html=elem.get("html", elem.get("text", "")),
                            block_type=block_type,
                            heading_context=elem.get("heading_context"),
                            position=position,
                        )
                        db.add(cb)
                    position += 1

            db.commit()
            # Fall through to Step 5 (image classification).
        else:
            section_groups = split_by_h2(elements)

            # Step 4: Create sections and content blocks
            job.pipeline_step = "merging"
            db.commit()

            existing_sections = {s.heading: s for s in tt.sections}

            for idx, (heading, elems) in enumerate(section_groups):
                heading_tree = build_heading_tree(elems)
                content_text = "\n".join(e["text"] for e in elems if e.get("text"))
                content_html = build_content_html(elems)

                image_count = sum(1 for e in elems if e.get("type") == "image")
                table_count = sum(1 for e in elems if e.get("type") == "table")
                # Source had verbatim-duplicated content that parsing auto-collapsed.
                # dup_flag is None when nothing was collapsed, else lists the lines.
                dup_flag = dup_collapsed_flag(elems)

                # Match this section's heading to the deepest curriculum node possible
                sec_topic_id, sec_topic_path = _match_section_to_curriculum(db, heading, tt.curriculum_id)

                if heading in existing_sections:
                    # Merge into existing section. content_html/text are fully REPLACED
                    # by this upload, so the old content blocks are stale — delete them
                    # before re-creating, else they accumulate (block doubling on
                    # re-upload). Content blocks are never referenced by cards, so this
                    # is card-safe.
                    section = existing_sections[heading]
                    db.query(ContentBlock).filter(ContentBlock.section_id == section.id).delete()
                    # Old images: only clear those NOT referenced by any card (cards
                    # point at images via ref_img_id). A re-upload that fixes section
                    # text must never orphan a card's image reference.
                    referenced_img_ids = {
                        r[0] for r in db.query(Card.ref_img_id)
                        .filter(Card.section_id == section.id, Card.ref_img_id.isnot(None)).all()
                    }
                    stale_imgs = db.query(SectionImage).filter(SectionImage.section_id == section.id).all()
                    for img in stale_imgs:
                        if img.id not in referenced_img_ids:
                            db.delete(img)
                    section.content_text = content_text
                    section.content_html = content_html
                    section.heading_tree = heading_tree
                    # Count current images = kept (referenced) + new ones added below.
                    section.image_count = image_count + len(referenced_img_ids)
                    section.table_count = table_count
                    section.updated_at = utcnow()
                    if "NO INFORMATION IN ORIGINAL STUDY GUIDE" in content_text.upper():
                        section.section_status = "orange"
                    # Content is fully replaced on re-upload, so drop any prior
                    # dup-collapsed flag (its line list is stale) before re-adding.
                    kept = [f for f in (section.flags or []) if not str(f).startswith(DUP_COLLAPSED_FLAG)]
                    section.flags = _merge_flag(kept, dup_flag)
                    # Update topic if set and not already assigned
                    if sec_topic_id and not section.curriculum_topic_id:
                        section.curriculum_topic_id = sec_topic_id
                        section.curriculum_topic_path = sec_topic_path
                else:
                    auto_status = "orange" if "NO INFORMATION IN ORIGINAL STUDY GUIDE" in content_text.upper() else "normal"
                    section = Section(
                        topic_tree_id=tt.id,
                        heading=heading,
                        slug=slugify(heading),
                        heading_tree=heading_tree,
                        content_text=content_text,
                        content_html=content_html,
                        image_count=image_count,
                        table_count=table_count,
                        sort_order=idx,
                        curriculum_topic_id=sec_topic_id,
                        curriculum_topic_path=sec_topic_path,
                        section_status=auto_status,
                        flags=[dup_flag] if dup_flag else None,
                    )
                    db.add(section)
                    db.flush()

                # Create content blocks
                position = 0
                for elem in elems:
                    block_type = elem.get("type", "paragraph")
                    if block_type == "image":
                        # Store as SectionImage
                        if elem.get("data_uri"):
                            img = SectionImage(
                                section_id=section.id,
                                upload_id=upload.id,
                                data_uri=elem["data_uri"],
                                alt_text_hint=elem.get("alt_text"),
                                position=position,
                            )
                            db.add(img)
                    else:
                        cb = ContentBlock(
                            section_id=section.id,
                            upload_id=upload.id,
                            text=elem.get("text", ""),
                            html=elem.get("html", elem.get("text", "")),
                            block_type=block_type,
                            heading_context=elem.get("heading_context"),
                            position=position,
                        )
                        db.add(cb)
                    position += 1

        # Step 5: Classify and process images
        images_to_process = (
            db.query(SectionImage)
            .join(Section, SectionImage.section_id == Section.id)
            .filter(Section.topic_tree_id == tt.id, SectionImage.upload_id == upload.id)
            .all()
        )

        if images_to_process:
            job.pipeline_step = "images"
            db.commit()

            from backend.services.image_classifier import classify_image
            from backend.config import ANTHROPIC_API_KEY
            import anthropic
            from collections import defaultdict

            client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

            # Group by section, sorted by position — order determines [Image N] index
            images_by_section = defaultdict(list)
            for img in images_to_process:
                images_by_section[img.section_id].append(img)
            for sid in images_by_section:
                images_by_section[sid].sort(key=lambda i: i.position)

            for section_id, section_images in images_by_section.items():
                section = db.get(Section, section_id)
                content_html = section.content_html
                content_text = section.content_text

                for img_num, img in enumerate(section_images, start=1):
                    intent = _parse_alt_text_hint(img.alt_text_hint)

                    if intent["command"] == "ref":
                        # REF — keep as SectionImage, set position, no AI
                        img.category = "decorative"
                        img.intended_position = intent["intended_position"]

                    elif intent["command"] == "extract":
                        # EXTRACT — call AI, replace image placeholder with extracted text
                        hint_for_ai = (
                            f"This is a {intent['category_hint']} image."
                            if intent["category_hint"] else img.alt_text_hint
                        )
                        extracted = ""
                        for attempt in range(2):
                            try:
                                result = classify_image(client, img.data_uri, alt_text_hint=hint_for_ai)
                                extracted = (result.get("extracted_text") or "").strip()
                                break
                            except Exception:
                                logger.exception(
                                    "EXTRACT classification failed for image %d (attempt %d/2)",
                                    img.id, attempt + 1,
                                )
                                if attempt == 0:
                                    time.sleep(2)
                                # Final failure: treat as empty extraction — image kept below.

                        # Replace [Image N] placeholder in section HTML
                        placeholder = (
                            f'<div class="image-placeholder" data-img-index="{img_num}">'
                            f'[Image {img_num}]</div>'
                        )
                        if extracted:
                            replacement = f'<div class="extracted-image-text">{extracted}</div>'
                            content_html = content_html.replace(placeholder, replacement)
                            content_text = (content_text + "\n" + extracted).strip()
                            db.add(ContentBlock(
                                section_id=section_id,
                                upload_id=upload.id,
                                text=extracted,
                                html=replacement,
                                block_type="image_text",
                                position=img.position,
                            ))
                            db.delete(img)
                        else:
                            # Extraction failed/empty — KEEP the image and its
                            # placeholder so no content is destroyed; flag for review.
                            img.category = "unclear"
                            section.flags = _merge_flag(
                                section.flags,
                                f"Image {img_num}: text extraction failed — image kept",
                            )

                    else:
                        # No alt text — full AI classification, keep as SectionImage
                        result = classify_image(client, img.data_uri, alt_text_hint=None)
                        img.category = result["category"]
                        img.extracted_text = result.get("extracted_text")

                section.content_html = content_html
                section.content_text = content_text

            db.commit()

        upload.status = "ready"
        job.pipeline_step = "done"
        job.status = JobStatus.done
        job.finished_at = utcnow()
        db.commit()

    except Exception as e:
        logger.exception("Processing failed for job %d", job_id)
        try:
            job = db.get(ProcessingJob, job_id)
            if job:
                job.status = JobStatus.failed
                job.error_message = str(e)
                job.finished_at = utcnow()
            upload = db.get(Upload, job.upload_id) if job else None
            if upload:
                upload.status = "error"
            db.commit()
        except Exception:
            logger.exception("Failed to write error status for processing job %d", job_id)
    finally:
        db.close()


def _run_ai_heading_processing(job_id: int, curriculum_version: str = 'v1'):
    """Background task: re-process with AI-detected headings."""
    from backend.services.heading_detector import parse_docx_with_ai_headings
    from backend.services.table_converter import convert_table_elements
    from backend.services.doc_processor import split_by_h2, build_heading_tree, build_content_html, dup_collapsed_flag
    from backend.config import DEFAULT_MODEL

    db = SessionLocal()
    try:
        job = db.get(ProcessingJob, job_id)
        job.status = JobStatus.running
        job.started_at = utcnow()
        job.pipeline_step = "ai_detecting"
        db.commit()

        upload = db.get(Upload, job.upload_id)
        tt = db.get(TopicTree, upload.topic_tree_id)
        filepath = os.path.join(UPLOAD_DIR, upload.filename)

        # Step 1: AI-assisted parse (auto-falls back to normal parse if headings already exist)
        elements = parse_docx_with_ai_headings(filepath, model=DEFAULT_MODEL, curriculum_version=curriculum_version)

        # Step 2: Table conversion
        job.pipeline_step = "tables"
        db.commit()
        elements = convert_table_elements(elements)

        # Step 3: Split by H2
        job.pipeline_step = "splitting"
        db.commit()
        section_groups = split_by_h2(elements)

        # Step 4: Create sections
        job.pipeline_step = "merging"
        db.commit()

        for idx, (heading, elems) in enumerate(section_groups):
            heading_tree = build_heading_tree(elems)
            content_text = "\n".join(e["text"] for e in elems if e.get("text"))
            content_html = build_content_html(elems)
            image_count = sum(1 for e in elems if e.get("type") == "image")
            table_count = sum(1 for e in elems if e.get("type") == "table")
            dup_flag = dup_collapsed_flag(elems)

            # Match this section's heading to the deepest curriculum node possible
            sec_topic_id, sec_topic_path = _match_section_to_curriculum(db, heading, tt.curriculum_id)

            auto_status = "orange" if "NO INFORMATION IN ORIGINAL STUDY GUIDE" in content_text.upper() else "normal"
            section = Section(
                topic_tree_id=tt.id,
                heading=heading,
                slug=slugify(heading),
                heading_tree=heading_tree,
                content_text=content_text,
                content_html=content_html,
                image_count=image_count,
                table_count=table_count,
                sort_order=idx,
                curriculum_topic_id=sec_topic_id,
                curriculum_topic_path=sec_topic_path,
                section_status=auto_status,
                flags=[dup_flag] if dup_flag else None,
            )
            db.add(section)
            db.flush()

            position = 0
            for elem in elems:
                block_type = elem.get("type", "paragraph")
                if block_type == "image":
                    if elem.get("data_uri"):
                        img = SectionImage(
                            section_id=section.id,
                            upload_id=upload.id,
                            data_uri=elem["data_uri"],
                            alt_text_hint=elem.get("alt_text"),
                            position=position,
                        )
                        db.add(img)
                else:
                    cb = ContentBlock(
                        section_id=section.id,
                        upload_id=upload.id,
                        text=elem.get("text", ""),
                        html=elem.get("html", elem.get("text", "")),
                        block_type=block_type,
                        heading_context=elem.get("heading_context"),
                        position=position,
                    )
                    db.add(cb)
                position += 1

        upload.status = "ready"
        job.pipeline_step = "done"
        job.status = JobStatus.done
        job.finished_at = utcnow()
        db.commit()

    except Exception as e:
        logger.exception("AI heading processing failed for job %d", job_id)
        try:
            job = db.get(ProcessingJob, job_id)
            if job:
                job.status = JobStatus.failed
                job.error_message = str(e)
                job.finished_at = utcnow()
            db.commit()
        except Exception:
            pass
    finally:
        db.close()
