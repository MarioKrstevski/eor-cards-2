"""Integration coverage for the curriculum-aligned ingestion flow.

(a) reconcile diff: _build_reconcile flags an unmatched H3 as missing and
    resolves a matched H3 to its curriculum node.
(b) processing: _run_processing(job_id, resolution) creates curriculum-aligned
    sections — matched leaf gets its own section, unmatched content rolls up to
    the parent — with clean content_text / heading_tree.

Section-creation approach: we drive the REAL _run_processing background pipeline
with a monkeypatched parse_docx returning a fixed element list (and the test
SessionLocal). This exercises the actual attach_content_to_curriculum +
Section/ContentBlock creation code path (least brittle: no docx file on disk, no
AI calls since the fixture has no images), rather than re-implementing it.
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import backend.routers.documents as docs_mod
import backend.services.doc_processor as dp_mod
from backend.db import Base
from backend.models import (
    Curriculum, TopicTree, Upload, ProcessingJob, JobStatus, Section,
)
from backend.services.doc_processor import parse_heading_outline


def _h(level, text):
    return {"type": "heading", "level": level, "text": text,
            "html": f"<h{level}>{text}</h{level}>"}


def _p(text):
    return {"type": "paragraph", "text": text, "html": f"<p>{text}</p>"}


# Document outline matching the Parasitic Infections example.
ELEMENTS = [
    _h(1, "Infectious Disease"),
    _h(2, "Parasitic Infections"),
    _h(3, "Giardiasis/GI Parasites"),
    _p("Amebiasis is a parasitic infection."),
    _p("Giardiasis causes diarrhea."),
    _h(3, "Toxoplasmosis"),
    _p("Toxoplasmosis is caused by T. gondii."),
]


@pytest.fixture
def env(tmp_path, monkeypatch):
    db_file = tmp_path / "reconcile.db"
    engine = create_engine(
        f"sqlite:///{db_file}", connect_args={"check_same_thread": False}
    )
    Base.metadata.create_all(bind=engine)
    TestSession = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    # _run_processing opens its own session via the documents-module SessionLocal.
    monkeypatch.setattr(docs_mod, "SessionLocal", TestSession)
    db = TestSession()
    try:
        yield db, TestSession
    finally:
        db.close()
        engine.dispose()


def _seed(db):
    """Seed curriculum + topic tree + upload with the Parasitic Infections outline.
    Returns (upload, node_ids dict)."""
    em = Curriculum(name="Emergency Medicine", level=0, path="Emergency Medicine",
                    version="v1")
    db.add(em)
    db.flush()
    idis = Curriculum(name="Infectious Disease", level=1, parent_id=em.id,
                      path="Emergency Medicine > Infectious Disease", version="v1")
    db.add(idis)
    db.flush()
    para = Curriculum(
        name="Parasitic Infections", level=2, parent_id=idis.id,
        path="Emergency Medicine > Infectious Disease > Parasitic Infections",
        version="v1")
    db.add(para)
    db.flush()
    toxo = Curriculum(
        name="Toxoplasmosis", level=3, parent_id=para.id,
        path="Emergency Medicine > Infectious Disease > Parasitic Infections > Toxoplasmosis",
        version="v1")
    db.add(toxo)
    db.flush()

    tt = TopicTree(name="Emergency Medicine", slug="emergency-medicine",
                   curriculum_id=em.id)
    db.add(tt)
    db.flush()

    upload = Upload(topic_tree_id=tt.id, original_name="parasites.docx",
                    filename="parasites.docx", status="processing")
    upload.heading_outline = parse_heading_outline(ELEMENTS)
    db.add(upload)
    db.commit()
    db.refresh(upload)

    ids = {"em": em.id, "idis": idis.id, "para": para.id, "toxo": toxo.id}
    return upload, ids


def test_reconcile_diff(env):
    db, _ = env
    upload, ids = _seed(db)

    reconcile = docs_mod._build_reconcile(db, upload)

    # Giardiasis/GI Parasites has no curriculum node -> reported missing.
    missing_names = [m["name"] for m in reconcile["missing_in_curriculum"]]
    assert "Giardiasis/GI Parasites" in missing_names

    # Toxoplasmosis heading resolves to the Toxoplasmosis node id.
    outline = upload.heading_outline
    # find the hid of the Toxoplasmosis heading
    toxo_hid = None

    def _find(nodes):
        nonlocal toxo_hid
        for n in nodes:
            if n["text"] == "Toxoplasmosis":
                toxo_hid = n["hid"]
            _find(n["children"])

    _find(outline)
    assert toxo_hid is not None
    assert reconcile["resolution"][toxo_hid] == ids["toxo"]


def test_processing_creates_curriculum_aligned_sections(env, monkeypatch):
    db, _ = env
    upload, ids = _seed(db)

    # Park a reconcile-gated job, then drive the real pipeline with the resolution.
    job = ProcessingJob(upload_id=upload.id, status=JobStatus.running,
                        pipeline_step="awaiting_reconcile")
    db.add(job)
    db.commit()
    job_id = job.id

    reconcile = docs_mod._build_reconcile(db, upload)
    resolution = reconcile["resolution"]

    # parse_docx is imported inside _run_processing from this module — patch there.
    monkeypatch.setattr(dp_mod, "parse_docx", lambda _fp: list(ELEMENTS))

    docs_mod._run_processing(job_id, resolution)

    db.expire_all()
    assert db.get(ProcessingJob, job_id).status == JobStatus.done

    sections = db.query(Section).all()
    by_path_tail = {s.curriculum_topic_path.split(" > ")[-1]: s for s in sections}

    # Toxoplasmosis content lives on its own leaf section.
    assert "Toxoplasmosis" in by_path_tail
    toxo_sec = by_path_tail["Toxoplasmosis"]
    assert "Toxoplasmosis is caused by T. gondii." in toxo_sec.content_text

    # Giardiasis content (unmatched H3) rolls up to Parasitic Infections.
    assert "Parasitic Infections" in by_path_tail
    para_sec = by_path_tail["Parasitic Infections"]
    assert "Giardiasis causes diarrhea." in para_sec.content_text
    assert "Amebiasis is a parasitic infection." in para_sec.content_text

    # Content cleanliness:
    # - Toxo section text holds no bare "Toxoplasmosis" title line (matched
    #   heading is a section title, not body content).
    toxo_lines = toxo_sec.content_text.split("\n")
    assert "Toxoplasmosis" not in toxo_lines
    # - Toxo section has no self-referential heading tree (no H3+ inside it).
    assert not toxo_sec.heading_tree
    # - Parasitic Infections section's heading tree DOES include the unmatched H3.
    para_headings = [n["heading"] for n in (para_sec.heading_tree or [])]
    assert "Giardiasis/GI Parasites" in para_headings
