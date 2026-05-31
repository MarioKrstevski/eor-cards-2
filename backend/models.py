from datetime import datetime, timezone
from typing import Optional
from sqlalchemy import String, Text, Boolean, Integer, Float, JSON, ForeignKey, Enum, BigInteger, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from backend.db import Base
import enum
import re


def utcnow():
    return datetime.now(timezone.utc)


def slugify(text: str) -> str:
    """Convert text to a URL-friendly slug."""
    text = text.lower().strip()
    text = re.sub(r'[^\w\s-]', '', text)
    text = re.sub(r'[\s_]+', '-', text)
    text = re.sub(r'-+', '-', text)
    return text.strip('-')


# ── Curriculum ──

class Curriculum(Base):
    __tablename__ = "curriculum"
    id: Mapped[int] = mapped_column(primary_key=True)
    parent_id: Mapped[Optional[int]] = mapped_column(ForeignKey("curriculum.id"), nullable=True)
    name: Mapped[str] = mapped_column(String(200))
    level: Mapped[int] = mapped_column(Integer, default=0)
    path: Mapped[str] = mapped_column(String(500))
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    version: Mapped[str] = mapped_column(String(10), default='v1', server_default='v1')
    children: Mapped[list["Curriculum"]] = relationship("Curriculum", back_populates="parent")
    parent: Mapped[Optional["Curriculum"]] = relationship("Curriculum", back_populates="children", remote_side="Curriculum.id")


# ── Rule Sets ──

class RuleSet(Base):
    __tablename__ = "rule_sets"
    __table_args__ = (UniqueConstraint("name", "rule_type", name="uq_ruleset_name_type"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    content: Mapped[str] = mapped_column(Text)
    rule_type: Mapped[str] = mapped_column(String(20), default="generation")
    card_version: Mapped[str] = mapped_column(String(10), default="base")  # base/v1/v2/v3
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


# ── Topic Tree (one per H1 main topic) ──

class TopicTree(Base):
    __tablename__ = "topic_trees"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(300))
    slug: Mapped[str] = mapped_column(String(300), unique=True)
    curriculum_id: Mapped[Optional[int]] = mapped_column(ForeignKey("curriculum.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    sections: Mapped[list["Section"]] = relationship("Section", back_populates="topic_tree", cascade="all, delete-orphan")
    uploads: Mapped[list["Upload"]] = relationship("Upload", back_populates="topic_tree", cascade="all, delete-orphan")


# ── Section (one per H2 subtopic) ──

class Section(Base):
    __tablename__ = "sections"
    id: Mapped[int] = mapped_column(primary_key=True)
    topic_tree_id: Mapped[int] = mapped_column(ForeignKey("topic_trees.id"))
    heading: Mapped[str] = mapped_column(String(500))
    slug: Mapped[str] = mapped_column(String(500))
    heading_tree: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)  # nested H3/H4 structure
    content_text: Mapped[str] = mapped_column(Text, default="")  # merged plain text
    content_html: Mapped[str] = mapped_column(Text, default="")  # for display
    curriculum_topic_id: Mapped[Optional[int]] = mapped_column(ForeignKey("curriculum.id"), nullable=True)
    curriculum_topic_path: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    image_count: Mapped[int] = mapped_column(Integer, default=0)
    table_count: Mapped[int] = mapped_column(Integer, default=0)
    flags: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    is_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    section_status: Mapped[str] = mapped_column(String(20), default="normal")  # normal, green, orange
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)
    topic_tree: Mapped["TopicTree"] = relationship("TopicTree", back_populates="sections")
    content_blocks: Mapped[list["ContentBlock"]] = relationship("ContentBlock", back_populates="section", cascade="all, delete-orphan")
    images: Mapped[list["SectionImage"]] = relationship("SectionImage", back_populates="section", cascade="all, delete-orphan")
    cards: Mapped[list["Card"]] = relationship("Card", back_populates="section", cascade="all, delete-orphan")


# ── Content Block ──

class ContentBlock(Base):
    __tablename__ = "content_blocks"
    id: Mapped[int] = mapped_column(primary_key=True)
    section_id: Mapped[int] = mapped_column(ForeignKey("sections.id"))
    upload_id: Mapped[Optional[int]] = mapped_column(ForeignKey("uploads.id"), nullable=True)
    text: Mapped[str] = mapped_column(Text, default="")
    html: Mapped[str] = mapped_column(Text, default="")
    block_type: Mapped[str] = mapped_column(String(50), default="paragraph")  # paragraph/heading/table/image_text
    heading_context: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)  # e.g. "H3: Diagnosis > H4: BNP Levels"
    position: Mapped[int] = mapped_column(Integer, default=0)
    is_duplicate: Mapped[bool] = mapped_column(Boolean, default=False)
    duplicate_of_id: Mapped[Optional[int]] = mapped_column(ForeignKey("content_blocks.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    section: Mapped["Section"] = relationship("Section", back_populates="content_blocks")
    upload: Mapped[Optional["Upload"]] = relationship("Upload", back_populates="content_blocks")


# ── Upload ──

class Upload(Base):
    __tablename__ = "uploads"
    id: Mapped[int] = mapped_column(primary_key=True)
    topic_tree_id: Mapped[int] = mapped_column(ForeignKey("topic_trees.id"))
    original_name: Mapped[str] = mapped_column(String(300))
    filename: Mapped[str] = mapped_column(String(300))
    status: Mapped[str] = mapped_column(String(20), default="processing")  # processing/ready/error/merged
    processing_log: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    uploaded_at: Mapped[datetime] = mapped_column(default=utcnow)
    topic_tree: Mapped["TopicTree"] = relationship("TopicTree", back_populates="uploads")
    content_blocks: Mapped[list["ContentBlock"]] = relationship("ContentBlock", back_populates="upload")


# ── Section Image ──

class SectionImage(Base):
    __tablename__ = "section_images"
    id: Mapped[int] = mapped_column(primary_key=True)
    section_id: Mapped[int] = mapped_column(ForeignKey("sections.id"))
    upload_id: Mapped[Optional[int]] = mapped_column(ForeignKey("uploads.id"), nullable=True)
    data_uri: Mapped[str] = mapped_column(Text)
    category: Mapped[str] = mapped_column(String(50), default="unclear")  # decorative/diagram/chart/table_image/unclear
    extracted_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    alt_text_hint: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    intended_position: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)  # front/back/None
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    section: Mapped["Section"] = relationship("Section", back_populates="images")


# ── Card ──

class CardStatus(str, enum.Enum):
    active = "active"
    rejected = "rejected"


class Card(Base):
    __tablename__ = "cards"
    id: Mapped[int] = mapped_column(primary_key=True)
    section_id: Mapped[int] = mapped_column(ForeignKey("sections.id"))
    card_number: Mapped[int] = mapped_column(Integer)
    front_html: Mapped[str] = mapped_column(Text)
    front_html_v1: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    front_html_v2: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    front_html_v3: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    front_text: Mapped[str] = mapped_column(Text)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    tags_mapped: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)  # new curriculum tags after mapping
    extra: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    vignette: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    teaching_case: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    source_ref: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    ref_img_id: Mapped[Optional[int]] = mapped_column(ForeignKey("section_images.id"), nullable=True)
    ref_img_position: Mapped[str] = mapped_column(String(10), default="front")
    note_id: Mapped[Optional[int]] = mapped_column(BigInteger, unique=True, nullable=True)
    status: Mapped[CardStatus] = mapped_column(Enum(CardStatus), default=CardStatus.active)
    needs_review: Mapped[bool] = mapped_column(Boolean, default=False)
    is_reviewed: Mapped[bool] = mapped_column(Boolean, default=False)
    review_mark_id: Mapped[Optional[int]] = mapped_column(ForeignKey("review_mark_types.id"), nullable=True)
    in_fix_batch: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)
    section: Mapped["Section"] = relationship("Section", back_populates="cards")


# ── Curriculum Mapping ──

class CurriculumMapping(Base):
    __tablename__ = "curriculum_mappings"
    id: Mapped[int] = mapped_column(primary_key=True)
    from_node_id: Mapped[int] = mapped_column(ForeignKey("curriculum.id"))
    to_node_id: Mapped[int] = mapped_column(ForeignKey("curriculum.id"))
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    from_node: Mapped["Curriculum"] = relationship("Curriculum", foreign_keys=[from_node_id])
    to_node: Mapped["Curriculum"] = relationship("Curriculum", foreign_keys=[to_node_id])


# ── Review Mark Types ──
class ReviewMarkType(Base):
    __tablename__ = "review_mark_types"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    color: Mapped[str] = mapped_column(String(7), default='#6b7280')
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


# ── Fix Batch ──
class FixBatch(Base):
    __tablename__ = "fix_batches"
    id: Mapped[int] = mapped_column(primary_key=True)
    mark_type_id: Mapped[Optional[int]] = mapped_column(ForeignKey("review_mark_types.id"), nullable=True)
    prompt: Mapped[str] = mapped_column(Text)
    model: Mapped[str] = mapped_column(String(100))
    status: Mapped[str] = mapped_column(String(20), default='pending')  # pending/running/done/confirmed/cancelled
    total_cards: Mapped[int] = mapped_column(Integer, default=0)
    processed_cards: Mapped[int] = mapped_column(Integer, default=0)
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    finished_at: Mapped[Optional[datetime]] = mapped_column(nullable=True)
    mark_type: Mapped[Optional["ReviewMarkType"]] = relationship("ReviewMarkType")
    proposals: Mapped[list["FixProposal"]] = relationship("FixProposal", back_populates="batch", cascade="all, delete-orphan")


# ── Fix Proposal ──
class FixProposal(Base):
    __tablename__ = "fix_proposals"
    id: Mapped[int] = mapped_column(primary_key=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("fix_batches.id"))
    original_card_id: Mapped[int] = mapped_column(ForeignKey("cards.id"))
    ai_action: Mapped[str] = mapped_column(String(10))  # edit/keep/delete/split
    proposed_front_html: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    proposed_extra: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    new_cards_json: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    reviewer_action: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    is_resolved: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    batch: Mapped["FixBatch"] = relationship("FixBatch", back_populates="proposals")
    original_card: Mapped["Card"] = relationship("Card", foreign_keys=[original_card_id])


# ── Generation Job ──

class JobStatus(str, enum.Enum):
    pending = "pending"
    running = "running"
    done = "done"
    failed = "failed"


class GenerationJob(Base):
    __tablename__ = "generation_jobs"
    id: Mapped[int] = mapped_column(primary_key=True)
    section_id: Mapped[Optional[int]] = mapped_column(ForeignKey("sections.id"), nullable=True)
    topic_tree_id: Mapped[Optional[int]] = mapped_column(ForeignKey("topic_trees.id"), nullable=True)
    job_type: Mapped[str] = mapped_column(String(20), default="cards")  # cards/supplemental/full
    scope: Mapped[str] = mapped_column(String(20), default="all")
    model: Mapped[str] = mapped_column(String(100))
    rule_set_id: Mapped[Optional[int]] = mapped_column(ForeignKey("rule_sets.id"), nullable=True)
    status: Mapped[JobStatus] = mapped_column(Enum(JobStatus), default=JobStatus.pending)
    total_sections: Mapped[int] = mapped_column(Integer, default=0)
    processed_sections: Mapped[int] = mapped_column(Integer, default=0)
    total_cards: Mapped[int] = mapped_column(Integer, default=0)
    estimated_cost_usd: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    actual_input_tokens: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    actual_output_tokens: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    pipeline_step: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    started_at: Mapped[Optional[datetime]] = mapped_column(nullable=True)
    finished_at: Mapped[Optional[datetime]] = mapped_column(nullable=True)


# ── Processing Job ──

class ProcessingJob(Base):
    __tablename__ = "processing_jobs"
    id: Mapped[int] = mapped_column(primary_key=True)
    upload_id: Mapped[int] = mapped_column(ForeignKey("uploads.id"))
    status: Mapped[JobStatus] = mapped_column(Enum(JobStatus), default=JobStatus.pending)
    pipeline_step: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)  # parsing/images/tables/comparing/merging/done
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    started_at: Mapped[Optional[datetime]] = mapped_column(nullable=True)
    finished_at: Mapped[Optional[datetime]] = mapped_column(nullable=True)
    upload: Mapped["Upload"] = relationship("Upload")


# ── Presentation (Ankify shareable deck) ──

class Presentation(Base):
    __tablename__ = "presentations"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(300))
    slug: Mapped[str] = mapped_column(String(300), unique=True)
    card_version: Mapped[str] = mapped_column(String(10), default="base")  # base/v1/v2/v3
    source_type: Mapped[str] = mapped_column(String(20), default="cards")  # cards | topic
    card_ids: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)   # used when source_type='cards'
    topic_tree_id: Mapped[Optional[int]] = mapped_column(ForeignKey("topic_trees.id"), nullable=True)  # used when source_type='topic'
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


# ── AI Usage Log ──

class AIUsageLog(Base):
    __tablename__ = "ai_usage_log"
    id: Mapped[int] = mapped_column(primary_key=True)
    operation: Mapped[str] = mapped_column(String(50))
    model: Mapped[str] = mapped_column(String(100))
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    topic_tree_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    section_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    card_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    job_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
