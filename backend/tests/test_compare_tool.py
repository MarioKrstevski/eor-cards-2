"""Compare tool: JSON→outline conversion, /curriculum/compare diff, cascade-green
marking, and subtree / all-green removal."""
import os
import tempfile

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.services.curriculum_aligner import json_tree_to_outline


# ── Pure converter ────────────────────────────────────────────────────────────

def test_json_tree_to_outline_shape_and_hids():
    outline = json_tree_to_outline([
        {"name": "Cardiovascular", "children": [
            {"name": "Arrhythmias", "children": [{"name": "Atrial"}]},
        ]},
        {"name": "Pulmonary"},
    ])
    assert [n["text"] for n in outline] == ["Cardiovascular", "Pulmonary"]
    cardio = outline[0]
    assert cardio["hid"] == 0 and cardio["level"] == 1
    arr = cardio["children"][0]
    assert arr["text"] == "Arrhythmias" and arr["hid"] == 1 and arr["level"] == 2
    assert arr["children"][0]["text"] == "Atrial" and arr["children"][0]["hid"] == 2
    assert outline[1]["hid"] == 3


def test_json_tree_to_outline_unwraps_main_topic_root():
    outline = json_tree_to_outline(
        {"name": "Surgery", "children": [{"name": "Trauma"}]}, main_topic_name="Surgery",
    )
    assert [n["text"] for n in outline] == ["Trauma"]
    assert outline[0]["level"] == 1


def test_json_tree_to_outline_rejects_garbage():
    with pytest.raises(ValueError):
        json_tree_to_outline("not a list")
    with pytest.raises(ValueError):
        json_tree_to_outline([{"children": []}])  # no name


# ── Endpoint tests (temp sqlite) ──────────────────────────────────────────────

@pytest.fixture()
def client_db(monkeypatch):
    from backend.db import Base, get_db
    from backend.main import app

    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    TestSession = sessionmaker(bind=engine, autocommit=False, autoflush=False)

    def override_get_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    client = TestClient(app)
    db = TestSession()
    try:
        yield client, db
    finally:
        db.close()
        app.dependency_overrides.pop(get_db, None)
        os.unlink(path)


def _seed(db):
    """Main topic + Cardio > Arrhythmias, plus an intruder Legacy > Old Leaf."""
    from backend.models import Curriculum, TopicTree, Section
    main = Curriculum(name="EM", level=0, path="EM", version="v1", sort_order=0)
    db.add(main); db.flush()
    cardio = Curriculum(name="Cardio", parent_id=main.id, level=1, path="EM > Cardio", version="v1", sort_order=1)
    db.add(cardio); db.flush()
    arr = Curriculum(name="Arrhythmias", parent_id=cardio.id, level=2, path="EM > Cardio > Arrhythmias", version="v1", sort_order=1)
    legacy = Curriculum(name="Legacy", parent_id=main.id, level=1, path="EM > Legacy", version="v1", sort_order=2)
    db.add_all([arr, legacy]); db.flush()
    old_leaf = Curriculum(name="Old Leaf", parent_id=legacy.id, level=2, path="EM > Legacy > Old Leaf", version="v1", sort_order=1)
    db.add(old_leaf); db.flush()
    tt = TopicTree(name="EM Doc", slug="em-doc", curriculum_id=main.id)
    db.add(tt); db.flush()
    sec = Section(topic_tree_id=tt.id, heading="Old Leaf", slug="old-leaf",
                  curriculum_topic_id=old_leaf.id, curriculum_topic_path=old_leaf.path,
                  content_text="x", content_html="<p>x</p>", section_status="normal", sort_order=0)
    db.add(sec); db.commit()
    return main, legacy, old_leaf, sec


def test_compare_flags_intruders_and_missing(client_db):
    client, db = client_db
    main, legacy, old_leaf, _ = _seed(db)
    resp = client.post("/api/curriculum/compare", json={
        "main_topic_id": main.id,
        "nodes": [{"name": "Cardio", "children": [{"name": "Arrhythmias"}]},
                  {"name": "Brand New Band"}],
    })
    assert resp.status_code == 200, resp.text
    tree = resp.json()["tree"]
    by_name = {c["name"]: c for c in tree["children"]}
    assert by_name["Cardio"]["status"] == "matched"
    assert by_name["Legacy"]["status"] == "missing"          # intruder
    assert by_name["Legacy"]["children"][0]["status"] == "missing"
    assert by_name["Brand New Band"]["status"] == "new"      # absent from system


def test_cascade_green_marks_subtree_and_sections(client_db):
    client, db = client_db
    main, legacy, old_leaf, sec = _seed(db)
    resp = client.patch(f"/api/curriculum/{legacy.id}",
                        json={"color": "green", "cascade_green": True})
    assert resp.status_code == 200, resp.text
    db.expire_all()
    assert db.get(type(legacy), legacy.id).color == "green"
    assert db.get(type(old_leaf), old_leaf.id).color == "green"   # descendant too
    assert db.get(type(sec), sec.id).section_status == "green"    # section flipped


def test_subtree_delete_removes_topics_and_sections(client_db):
    client, db = client_db
    from backend.models import Curriculum, Section
    main, legacy, old_leaf, sec = _seed(db)
    main_id, legacy_id, old_leaf_id, sec_id = main.id, legacy.id, old_leaf.id, sec.id
    resp = client.delete(f"/api/curriculum/{legacy_id}", params={"subtree": True})
    assert resp.status_code in (200, 204), resp.text
    db.expunge_all()
    assert db.get(Curriculum, legacy_id) is None
    assert db.get(Curriculum, old_leaf_id) is None
    assert db.get(Section, sec_id) is None
    assert db.get(Curriculum, main_id) is not None  # untouched


def test_delete_all_green(client_db):
    client, db = client_db
    from backend.models import Curriculum, Section
    main, legacy, old_leaf, sec = _seed(db)
    main_id, legacy_id, old_leaf_id, sec_id = main.id, legacy.id, old_leaf.id, sec.id
    # Mark the intruder subtree green first, then bulk-delete greens.
    client.patch(f"/api/curriculum/{legacy_id}", json={"color": "green", "cascade_green": True})
    resp = client.delete("/api/curriculum/green", params={"version": "v1"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["removed_topics"] == 2 and body["removed_sections"] == 1
    db.expunge_all()
    assert db.get(Curriculum, legacy_id) is None
    assert db.get(Curriculum, old_leaf_id) is None
    assert db.get(Section, sec_id) is None
    assert db.get(Curriculum, main_id) is not None


def test_reset_topic_children(client_db):
    client, db = client_db
    from backend.models import Curriculum, Section
    main, legacy, old_leaf, sec = _seed(db)
    main_id, legacy_id, sec_id = main.id, legacy.id, sec.id
    resp = client.post(f"/api/curriculum/{main_id}/reset", json={
        "nodes": [{"name": "Fresh Band", "children": [{"name": "Fresh Leaf"}]}],
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["imported"] == 2
    assert body["removed_topics"] == 4      # Cardio, Arrhythmias, Legacy, Old Leaf
    assert body["removed_sections"] == 1
    db.expunge_all()
    assert db.get(Curriculum, legacy_id) is None
    assert db.get(Section, sec_id) is None
    fresh = db.query(Curriculum).filter_by(version="v1", name="Fresh Band").first()
    assert fresh is not None and fresh.parent_id == main_id and fresh.level == 1
    leaf = db.query(Curriculum).filter_by(version="v1", name="Fresh Leaf").first()
    assert leaf is not None and leaf.path == "EM > Fresh Band > Fresh Leaf"


def test_reset_rejects_non_root(client_db):
    client, db = client_db
    main, legacy, old_leaf, sec = _seed(db)
    resp = client.post(f"/api/curriculum/{legacy.id}/reset", json={"nodes": [{"name": "X"}]})
    assert resp.status_code == 400
