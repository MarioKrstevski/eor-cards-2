import os
import tempfile
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import func
from pydantic import BaseModel
from typing import Optional
from backend.db import get_db
from backend.models import Section, ContentBlock, SectionImage, utcnow
from backend.services.doc_processor import parse_html, build_content_html

router = APIRouter()


class SectionUpdate(BaseModel):
    heading: Optional[str] = None
    content_text: Optional[str] = None
    content_html: Optional[str] = None
    curriculum_topic_id: Optional[int] = None
    curriculum_topic_path: Optional[str] = None
    is_verified: Optional[bool] = None
    flags: Optional[list] = None
    section_status: Optional[str] = None


def section_to_dict(s: Section) -> dict:
    return {
        "id": s.id,
        "topic_tree_id": s.topic_tree_id,
        "heading": s.heading,
        "slug": s.slug,
        "heading_tree": s.heading_tree,
        "content_text": s.content_text,
        "content_html": s.content_html,
        "curriculum_topic_id": s.curriculum_topic_id,
        "curriculum_topic_path": s.curriculum_topic_path,
        "image_count": s.image_count,
        "table_count": s.table_count,
        "flags": s.flags,
        "is_verified": s.is_verified,
        "sort_order": s.sort_order,
        "section_status": s.section_status,
        "card_count": len(s.cards) if s.cards else 0,
        "content_blocks": [
            {
                "id": cb.id,
                "text": cb.text,
                "html": cb.html,
                "block_type": cb.block_type,
                "heading_context": cb.heading_context,
                "position": cb.position,
                "is_duplicate": cb.is_duplicate,
            }
            for cb in sorted(s.content_blocks, key=lambda b: b.position)
        ],
        "images": [
            {
                "id": img.id,
                "data_uri": img.data_uri,
                "category": img.category,
                "extracted_text": img.extracted_text,
                "alt_text_hint": img.alt_text_hint,
                "position": img.position,
            }
            for img in sorted(s.images, key=lambda i: i.position)
        ],
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "updated_at": s.updated_at.isoformat() if s.updated_at else None,
    }


@router.get("/by-curriculum")
def get_sections_by_curriculum(
    path: str = Query(...),
    db: Session = Depends(get_db),
):
    """Return all sections whose curriculum_topic_path starts with the given path prefix.

    Note: the path itself may contain literal '%' (e.g. 'Pulmonary – 10%'), so we escape
    LIKE wildcards before appending the trailing '%' wildcard.
    """
    escaped = path.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    sections = (
        db.query(Section)
        .options(joinedload(Section.topic_tree), joinedload(Section.cards))
        .filter(Section.curriculum_topic_path.like(escaped + "%", escape="\\"))
        .order_by(Section.sort_order)
        .all()
    )
    return [
        {
            "id": s.id,
            "topic_tree_id": s.topic_tree_id,
            "topic_tree_name": s.topic_tree.name if s.topic_tree else None,
            "heading": s.heading,
            "slug": s.slug,
            "curriculum_topic_id": s.curriculum_topic_id,
            "curriculum_topic_path": s.curriculum_topic_path,
            "image_count": s.image_count,
            "table_count": s.table_count,
            "flags": s.flags,
            "is_verified": s.is_verified,
            "sort_order": s.sort_order,
            "section_status": s.section_status,
            "card_count": len(s.cards) if s.cards else 0,
        }
        for s in sections
    ]


@router.get("/{section_id}")
def get_section(section_id: int, db: Session = Depends(get_db)):
    section = db.get(Section, section_id)
    if not section:
        raise HTTPException(404)
    return section_to_dict(section)


@router.patch("/{section_id}")
def update_section(section_id: int, body: SectionUpdate, db: Session = Depends(get_db)):
    section = db.get(Section, section_id)
    if not section:
        raise HTTPException(404)
    if body.heading is not None:
        section.heading = body.heading
    if body.content_text is not None:
        section.content_text = body.content_text
    if body.content_html is not None:
        section.content_html = body.content_html
    if body.curriculum_topic_id is not None:
        section.curriculum_topic_id = body.curriculum_topic_id
    if body.curriculum_topic_path is not None:
        section.curriculum_topic_path = body.curriculum_topic_path
    if body.is_verified is not None:
        section.is_verified = body.is_verified
    if body.flags is not None:
        section.flags = body.flags
    if body.section_status is not None:
        section.section_status = body.section_status
    db.commit()
    db.refresh(section)
    return section_to_dict(section)


@router.post("/{section_id}/paste")
def paste_section_content(section_id: int, body: dict, db: Session = Depends(get_db)):
    """Replace section content with pasted HTML."""
    section = db.get(Section, section_id)
    if not section:
        raise HTTPException(404)

    html = body.get("html", "")
    if not html.strip():
        raise HTTPException(400, "No HTML content provided")

    # Write to temp file for parser
    with tempfile.NamedTemporaryFile(mode='w', suffix='.html', delete=False, encoding='utf-8') as tmp:
        tmp.write(html)
        tmp_path = tmp.name

    try:
        elements = parse_html(tmp_path)
    finally:
        os.unlink(tmp_path)

    content_text = "\n".join(e["text"] for e in elements if e.get("text"))
    content_html_str = build_content_html(elements)

    section.content_text = content_text
    section.content_html = content_html_str

    # Auto-detect/clear orange status
    if "NO INFORMATION IN ORIGINAL STUDY GUIDE" in content_text.upper():
        section.section_status = "orange"
    elif hasattr(section, 'section_status') and section.section_status == "orange":
        section.section_status = "normal"

    # Handle images
    image_count = 0
    for elem in elements:
        if elem.get("type") == "image" and elem.get("data_uri"):
            img = SectionImage(
                section_id=section.id,
                data_uri=elem["data_uri"],
                alt_text_hint=elem.get("alt_text"),
                position=image_count,
            )
            db.add(img)
            image_count += 1

    section.image_count = (section.image_count or 0) + image_count
    section.updated_at = utcnow()
    db.commit()
    db.refresh(section)
    return section_to_dict(section)


@router.post("/{section_id}/verify")
def verify_section(section_id: int, db: Session = Depends(get_db)):
    """Mark section as verified (AI verification is a future enhancement)."""
    section = db.get(Section, section_id)
    if not section:
        raise HTTPException(404)
    section.is_verified = True
    db.commit()
    return {"is_valid": True, "flags": section.flags or []}


@router.post("/{section_id}/images")
async def upload_section_image(
    section_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Upload an image directly to a section's image library."""
    section = db.get(Section, section_id)
    if not section:
        raise HTTPException(404)

    import base64
    content = await file.read()
    mime = file.content_type or "image/png"
    data_uri = f"data:{mime};base64,{base64.b64encode(content).decode()}"

    max_pos = db.query(func.max(SectionImage.position)).filter_by(section_id=section_id).scalar() or 0
    img = SectionImage(
        section_id=section_id,
        data_uri=data_uri,
        alt_text_hint=file.filename,
        position=max_pos + 1,
        category="unclear",
    )
    db.add(img)
    section.image_count = (section.image_count or 0) + 1
    db.commit()
    db.refresh(img)

    return {
        "id": img.id,
        "section_id": img.section_id,
        "data_uri": img.data_uri,
        "category": img.category,
        "extracted_text": img.extracted_text,
        "alt_text_hint": img.alt_text_hint,
        "position": img.position,
    }


class SectionImageFromUrl(BaseModel):
    url: str


@router.post("/{section_id}/images/from-url")
def upload_section_image_from_url(section_id: int, body: SectionImageFromUrl, db: Session = Depends(get_db)):
    """Fetch an image by URL (server-side, no browser CORS) and store it in the
    section's image library. Used when the user drags an image from another website
    or app — the browser hands us a URL, not the file bytes."""
    import base64
    import httpx

    section = db.get(Section, section_id)
    if not section:
        raise HTTPException(404)

    url = (body.url or "").strip()
    if not url.lower().startswith(("http://", "https://")):
        raise HTTPException(400, "Only http(s) image URLs are supported")

    try:
        # A browser-like UA + referer-less request; follow redirects (CDNs love them).
        with httpx.Client(follow_redirects=True, timeout=15.0) as client:
            resp = client.get(url, headers={"User-Agent": "Mozilla/5.0 (EOR-Card-Studio image fetch)"})
        resp.raise_for_status()
    except Exception as e:  # noqa: BLE001 — surface any fetch failure to the user
        raise HTTPException(502, f"Could not fetch image: {e}")

    mime = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
    content = resp.content
    if not mime.startswith("image/"):
        raise HTTPException(415, f"URL did not return an image (got {mime or 'unknown type'})")
    if not content:
        raise HTTPException(502, "Fetched image was empty")

    data_uri = f"data:{mime};base64,{base64.b64encode(content).decode()}"

    max_pos = db.query(func.max(SectionImage.position)).filter_by(section_id=section_id).scalar() or 0
    img = SectionImage(
        section_id=section_id,
        data_uri=data_uri,
        alt_text_hint=url[:255],
        position=max_pos + 1,
        category="unclear",
    )
    db.add(img)
    section.image_count = (section.image_count or 0) + 1
    db.commit()
    db.refresh(img)

    return {
        "id": img.id,
        "section_id": img.section_id,
        "data_uri": img.data_uri,
        "category": img.category,
        "extracted_text": img.extracted_text,
        "alt_text_hint": img.alt_text_hint,
        "position": img.position,
    }


class SectionImageUpdate(BaseModel):
    category: Optional[str] = None
    alt_text_hint: Optional[str] = None
    intended_position: Optional[str] = None


@router.patch("/{section_id}/images/{image_id}")
def update_section_image(section_id: int, image_id: int, body: SectionImageUpdate, db: Session = Depends(get_db)):
    """Update an image's category or alt_text_hint."""
    img = db.get(SectionImage, image_id)
    if not img or img.section_id != section_id:
        raise HTTPException(404)

    if body.category is not None:
        img.category = body.category
    if body.alt_text_hint is not None:
        img.alt_text_hint = body.alt_text_hint
    if body.intended_position is not None:
        img.intended_position = body.intended_position
    db.commit()
    db.refresh(img)
    return {
        "id": img.id,
        "section_id": img.section_id,
        "data_uri": img.data_uri,
        "category": img.category,
        "extracted_text": img.extracted_text,
        "alt_text_hint": img.alt_text_hint,
        "intended_position": img.intended_position,
        "position": img.position,
    }


@router.delete("/{section_id}/images/{image_id}")
def delete_section_image(section_id: int, image_id: int, db: Session = Depends(get_db)):
    """Delete an image from a section's library."""
    img = db.get(SectionImage, image_id)
    if not img or img.section_id != section_id:
        raise HTTPException(404)

    # Clear ref_img_id on any cards referencing this image
    from backend.models import Card
    db.query(Card).filter(Card.ref_img_id == image_id).update(
        {Card.ref_img_id: None}, synchronize_session="fetch"
    )

    db.delete(img)
    section = db.get(Section, section_id)
    if section and section.image_count and section.image_count > 0:
        section.image_count -= 1
    db.commit()
    return {"ok": True}
