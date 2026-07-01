"""End-to-end coverage for the scan -> continue ingestion flow.

Approach: full HTTP via FastAPI TestClient.
  - `app.dependency_overrides[get_db]` points request handlers at a temp SQLite
    session.
  - `backend.routers.documents.SessionLocal` is monkeypatched to the SAME test
    session factory so the background `_run_processing` task writes to the test DB.
  - `backend.services.doc_processor.parse_docx` is monkeypatched to return a FIXED
    element list, so the uploaded bytes are irrelevant (no real .docx needed).
  - `SCAN_DIR` / `UPLOAD_DIR` (the names imported INTO documents.py) point at tmp
    dirs so the sidecar/.docx land in the test tmp tree.

TestClient runs BackgroundTasks synchronously after the response is returned, so
after a successful POST /continue the sections already exist in the test DB — we
assert on them directly. The fixture has no images, so no AI calls fire.
"""
import io
import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import backend.routers.documents as docs_mod
import backend.services.doc_processor as dp_mod
from backend.main import app
from backend.db import Base, get_db
from backend.models import (
    Curriculum, TopicTree, Upload, ProcessingJob, JobStatus, Section,
)


def _h(level, text):
    return {"type": "heading", "level": level, "text": text,
            "html": f"<h{level}>{text}</h{level}>"}


def _p(text):
    return {"type": "paragraph", "text": text, "html": f"<p>{text}</p>"}


# Document nesting depth maps to ABSOLUTE curriculum level (depth N -> level N),
# so the doc must root one level below the main topic. With main = Emergency
# Medicine (level 0): H1 -> level 1, H2 -> level 2, H3 -> level 3.
#
# H1 "Infectious Disease" (node) -> H2 "Parasitic Infections" (node) ->
#   H3 "Giardiasis/GI Parasites" (NO node) + H3 "Toxoplasmosis" (NO node —
#   created via /continue includes).
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
def client(tmp_path, monkeypatch):
    db_file = tmp_path / "scan.db"
    engine = create_engine(
        f"sqlite:///{db_file}", connect_args={"check_same_thread": False}
    )
    Base.metadata.create_all(bind=engine)
    TestSession = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    # Request handlers use the override; the background task uses module SessionLocal.
    def _override_get_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _override_get_db
    monkeypatch.setattr(docs_mod, "SessionLocal", TestSession)

    # No real docx parsing — fixed element list.
    monkeypatch.setattr(dp_mod, "parse_docx", lambda _fp: list(ELEMENTS))

    scan_dir = tmp_path / "scans"
    upload_dir = tmp_path / "uploads"
    scan_dir.mkdir()
    upload_dir.mkdir()
    monkeypatch.setattr(docs_mod, "SCAN_DIR", str(scan_dir))
    monkeypatch.setattr(docs_mod, "UPLOAD_DIR", str(upload_dir))

    c = TestClient(app)
    c.test_session = TestSession           # expose for assertions
    c.scan_dir = str(scan_dir)
    c.upload_dir = str(upload_dir)
    try:
        yield c
    finally:
        app.dependency_overrides.pop(get_db, None)
        engine.dispose()


def _seed_curriculum(db):
    """Emergency Medicine -> Infectious Disease -> Parasitic Infections.
    Toxoplasmosis is intentionally NOT seeded (created via /continue)."""
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
    ids = {"em": em.id, "idis": idis.id, "para": para.id}
    db.commit()
    return ids


def _multipart(name="parasites.docx", data=b"PK-fake-docx"):
    return {"file": (name, io.BytesIO(data),
                     "application/vnd.openxmlformats-officedocument.wordprocessingml.document")}


def _scan(client, curriculum_id):
    """POST /scan with the file + curriculum_id as multipart form fields."""
    return client.post(
        "/api/topic-trees/scan",
        files=_multipart(),
        data={"curriculum_id": str(curriculum_id)},
    )


def _walk_tree(node, fn):
    fn(node)
    for c in node.get("children", []):
        _walk_tree(c, fn)


def _find_new_hid(tree, name):
    found = []

    def _fn(n):
        if n.get("status") == "new" and n.get("name") == name:
            found.append(n["hid"])

    _walk_tree(tree, _fn)
    return found[0] if found else None


# --------------------------------------------------------------------------- #
# scan creates no DB rows
# --------------------------------------------------------------------------- #
def test_scan_creates_no_db_rows(client):
    db = client.test_session()
    try:
        ids = _seed_curriculum(db)
        tt_before = db.query(TopicTree).count()
    finally:
        db.close()

    resp = _scan(client, ids["em"])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "scan_token" in body and body["scan_token"]
    assert "tree" in body and body["tree"]["name"] == "Emergency Medicine"

    token = body["scan_token"]
    assert os.path.exists(os.path.join(client.scan_dir, token + ".json"))
    assert os.path.exists(os.path.join(client.scan_dir, token + ".docx"))

    db = client.test_session()
    try:
        assert db.query(TopicTree).count() == tt_before  # unchanged
        assert db.query(Upload).count() == 0
        assert db.query(ProcessingJob).count() == 0
        assert db.query(Section).count() == 0
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# continue applies includes + attaches content to curriculum nodes
# --------------------------------------------------------------------------- #
def test_continue_applies_includes_and_attaches(client):
    db = client.test_session()
    try:
        ids = _seed_curriculum(db)
    finally:
        db.close()

    # Scan first.
    resp = _scan(client, ids["em"])
    assert resp.status_code == 200, resp.text
    scan = resp.json()
    token = scan["scan_token"]

    # Find the `new` Toxoplasmosis node's hid in the merged tree.
    toxo_hid = _find_new_hid(scan["tree"], "Toxoplasmosis")
    assert toxo_hid is not None, "Toxoplasmosis should be grafted as a new node"

    # Continue — include ONLY Toxoplasmosis. Giardiasis/GI Parasites is left out.
    resp = client.post(
        "/api/topic-trees/continue",
        json={"scan_token": token, "included_hids": [toxo_hid]},
    )
    assert resp.status_code == 200, resp.text
    cont = resp.json()
    assert cont["processing_job_id"]
    assert cont["topic_tree_id"]

    db = client.test_session()
    try:
        # A Toxoplasmosis curriculum node now exists under Parasitic Infections.
        toxo = (db.query(Curriculum)
                .filter(Curriculum.name == "Toxoplasmosis").one_or_none())
        assert toxo is not None
        assert toxo.parent_id == ids["para"]
        assert toxo.path == (
            "Emergency Medicine > Infectious Disease > Parasitic Infections > Toxoplasmosis"
        )

        # The background task has run — job is done.
        job = db.get(ProcessingJob, cont["processing_job_id"])
        assert job.status == JobStatus.done, job.error_message

        sections = db.query(Section).all()
        by_tail = {s.curriculum_topic_path.split(" > ")[-1]: s for s in sections}

        # Toxoplasmosis content lands on its own (newly created) leaf section.
        assert "Toxoplasmosis" in by_tail
        assert toxo.id == by_tail["Toxoplasmosis"].curriculum_topic_id
        assert "Toxoplasmosis is caused by T. gondii." in by_tail["Toxoplasmosis"].content_text

        # Giardiasis was NOT included -> its content rolls up to Parasitic Infections.
        assert "Parasitic Infections" in by_tail
        para_sec = by_tail["Parasitic Infections"]
        assert "Giardiasis causes diarrhea." in para_sec.content_text
        assert "Amebiasis is a parasitic infection." in para_sec.content_text
        # The unincluded H3 survives as sub-structure in the rolled-up section.
        para_headings = [n["heading"] for n in (para_sec.heading_tree or [])]
        assert "Giardiasis/GI Parasites" in para_headings

        # The temp scan files were cleaned up / moved out of SCAN_DIR.
        assert not os.path.exists(os.path.join(client.scan_dir, token + ".json"))
        assert not os.path.exists(os.path.join(client.scan_dir, token + ".docx"))
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# expand/ancestor: including only a deep new node auto-creates its new ancestors
# --------------------------------------------------------------------------- #
NESTED_ELEMENTS = [
    _h(1, "Fungal Infections"),                  # NEW top-level (no node)
    _h(2, "Histoplasmosis"),                     # NEW child (no node)
    _p("Histoplasmosis is a fungal infection."),
]


def test_continue_auto_includes_ancestors(client, monkeypatch):
    monkeypatch.setattr(dp_mod, "parse_docx", lambda _fp: list(NESTED_ELEMENTS))

    db = client.test_session()
    try:
        ids = _seed_curriculum(db)
    finally:
        db.close()

    resp = _scan(client, ids["em"])
    assert resp.status_code == 200, resp.text
    scan = resp.json()
    token = scan["scan_token"]

    # Include ONLY the deep H3; its new H2 ancestor must be auto-created.
    h3_hid = _find_new_hid(scan["tree"], "Histoplasmosis")
    assert h3_hid is not None
    h2_hid = _find_new_hid(scan["tree"], "Fungal Infections")
    assert h2_hid is not None

    resp = client.post(
        "/api/topic-trees/continue",
        json={"scan_token": token, "included_hids": [h3_hid]},
    )
    assert resp.status_code == 200, resp.text

    db = client.test_session()
    try:
        fungal = (db.query(Curriculum)
                  .filter(Curriculum.name == "Fungal Infections").one_or_none())
        histo = (db.query(Curriculum)
                 .filter(Curriculum.name == "Histoplasmosis").one_or_none())
        assert fungal is not None, "new H2 ancestor must be auto-created"
        assert histo is not None, "new H3 must be created"
        # H3 nests under the auto-created H2, which nests under the main topic.
        assert histo.parent_id == fungal.id
        assert fungal.parent_id == ids["em"]
        assert histo.path == (
            "Emergency Medicine > Fungal Infections > Histoplasmosis"
        )
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# continue is idempotent: a second submit of the same token conflicts and
# never mints duplicate curriculum nodes
# --------------------------------------------------------------------------- #
def test_continue_second_submit_conflicts(client):
    db = client.test_session()
    try:
        ids = _seed_curriculum(db)
    finally:
        db.close()

    resp = _scan(client, ids["em"])
    assert resp.status_code == 200, resp.text
    scan = resp.json()
    token = scan["scan_token"]
    toxo_hid = _find_new_hid(scan["tree"], "Toxoplasmosis")

    json_path = os.path.join(client.scan_dir, token + ".json")
    consumed_path = json_path + ".consumed"

    # Simulate an in-flight first request (token already consumed) -> 409.
    os.rename(json_path, consumed_path)
    resp = client.post(
        "/api/topic-trees/continue",
        json={"scan_token": token, "included_hids": [toxo_hid]},
    )
    assert resp.status_code == 409, resp.text
    os.rename(consumed_path, json_path)

    # First real continue succeeds.
    resp = client.post(
        "/api/topic-trees/continue",
        json={"scan_token": token, "included_hids": [toxo_hid]},
    )
    assert resp.status_code == 200, resp.text

    db = client.test_session()
    try:
        node_count = db.query(Curriculum).count()
        assert db.query(Curriculum).filter(Curriculum.name == "Toxoplasmosis").count() == 1
    finally:
        db.close()

    # Second submit after success: token fully consumed -> 404, no new nodes.
    resp = client.post(
        "/api/topic-trees/continue",
        json={"scan_token": token, "included_hids": [toxo_hid]},
    )
    assert resp.status_code == 404, resp.text

    db = client.test_session()
    try:
        assert db.query(Curriculum).count() == node_count
        assert db.query(Curriculum).filter(Curriculum.name == "Toxoplasmosis").count() == 1
    finally:
        db.close()
