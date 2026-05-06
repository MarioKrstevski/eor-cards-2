import os
import uuid
import logging
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, BackgroundTasks
from sqlalchemy.orm import Session
from typing import Optional
from backend.db import get_db, SessionLocal
from backend.models import (
    TopicTree, Section, Upload, ProcessingJob, JobStatus,
    ContentBlock, SectionImage, Curriculum, slugify, utcnow,
)
from backend.config import UPLOAD_DIR

logger = logging.getLogger(__name__)

router = APIRouter()


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
        "card_count": len(s.cards) if s.cards else 0,
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "updated_at": s.updated_at.isoformat() if s.updated_at else None,
    }
    if include_content:
        d["content_text"] = s.content_text
        d["content_html"] = s.content_html
    return d


@router.post("/upload")
async def upload_document(
    file: UploadFile = File(...),
    topic_tree_name: Optional[str] = Form(None),
    topic_tree_id: Optional[int] = Form(None),
    curriculum_id: Optional[int] = Form(None),
    background_tasks: BackgroundTasks = None,
    db: Session = Depends(get_db),
):
    """Upload a .docx file, creating or targeting a topic tree, then auto-process."""
    if not file.filename.endswith(".docx"):
        raise HTTPException(400, "Only .docx files are supported")

    os.makedirs(UPLOAD_DIR, exist_ok=True)
    stored_name = f"{uuid.uuid4().hex}_{file.filename}"
    filepath = os.path.join(UPLOAD_DIR, stored_name)
    content = await file.read()
    with open(filepath, "wb") as f:
        f.write(content)

    # Create or get topic tree
    if topic_tree_id:
        tt = db.get(TopicTree, topic_tree_id)
        if not tt:
            raise HTTPException(404, "Topic tree not found")
    else:
        name = topic_tree_name or os.path.splitext(file.filename)[0]
        slug = slugify(name)
        existing = db.query(TopicTree).filter_by(slug=slug).first()
        if existing:
            raise HTTPException(
                409,
                f"A topic tree named '{existing.name}' already exists. "
                f"Upload into it by selecting it, or use a different name."
            )
        tt = TopicTree(
            name=name,
            slug=slug,
            curriculum_id=curriculum_id,
        )
        db.add(tt)
        db.flush()

    upload = Upload(
        topic_tree_id=tt.id,
        original_name=file.filename,
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
        tt = TopicTree(
            name=topic_tree_name,
            slug=slugify(topic_tree_name),
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


def _run_processing(job_id: int):
    """Background task: process an upload into sections and content blocks."""
    from backend.services.doc_processor import parse_docx, parse_html, split_by_h2, build_heading_tree, build_content_html
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

        # Step 3: Split by H2 into sections
        job.pipeline_step = "splitting"
        db.commit()
        section_groups = split_by_h2(elements)

        # Step 4: Create sections and content blocks
        job.pipeline_step = "merging"
        db.commit()

        existing_sections = {s.heading: s for s in tt.sections}

        # Resolve curriculum topic for inheriting to sections
        curriculum_topic_id = tt.curriculum_id
        curriculum_topic_path = None
        if curriculum_topic_id:
            cur_node = db.get(Curriculum, curriculum_topic_id)
            if cur_node:
                curriculum_topic_path = cur_node.path

        for idx, (heading, elems) in enumerate(section_groups):
            heading_tree = build_heading_tree(elems)
            content_text = "\n".join(e["text"] for e in elems if e.get("text"))
            content_html = build_content_html(elems)

            image_count = sum(1 for e in elems if e.get("type") == "image")
            table_count = sum(1 for e in elems if e.get("type") == "table")

            if heading in existing_sections:
                # Merge into existing section
                section = existing_sections[heading]
                section.content_text = content_text
                section.content_html = content_html
                section.heading_tree = heading_tree
                section.image_count += image_count
                section.table_count += table_count
                section.updated_at = utcnow()
                # Update topic if set and not already assigned
                if curriculum_topic_id and not section.curriculum_topic_id:
                    section.curriculum_topic_id = curriculum_topic_id
                    section.curriculum_topic_path = curriculum_topic_path
            else:
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
                    curriculum_topic_id=curriculum_topic_id,
                    curriculum_topic_path=curriculum_topic_path,
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
