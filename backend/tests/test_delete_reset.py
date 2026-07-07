"""Deleting a document resets its main topic's curriculum back to the shipped
blueprint (wiping green additions), but only when no other document remains on
that main topic."""
import os
import tempfile

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture()
def client_db():
    from backend.db import Base, get_db
    from backend.main import app

    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    engine = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    TestSession = sessionmaker(bind=engine, autocommit=False, autoflush=False)

    def override():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override
    client = TestClient(app)
    db = TestSession()
    try:
        yield client, db
    finally:
        db.close()
        app.dependency_overrides.pop(get_db, None)
        os.unlink(path)


def _seed_pediatrics(db):
    """Pediatrics main topic with a green add + a base child + a section + a tree."""
    from backend.models import Curriculum, TopicTree, Section
    main = Curriculum(name="Pediatrics", level=0, path="Pediatrics", version="v2", sort_order=0)
    db.add(main); db.flush()
    green = Curriculum(name="My Added Topic", parent_id=main.id, level=1,
                       path="Pediatrics > My Added Topic", version="v2", color="green", sort_order=1)
    db.add(green); db.flush()
    tt = TopicTree(name="Peds Doc", slug="peds-doc", curriculum_id=main.id)
    db.add(tt); db.flush()
    sec = Section(topic_tree_id=tt.id, heading="My Added Topic", slug="mat",
                  curriculum_topic_id=green.id, curriculum_topic_path=green.path,
                  content_text="x", content_html="<p>x</p>", sort_order=0)
    db.add(sec); db.commit()
    return main.id, green.id, tt.id, sec.id


def test_delete_resets_curriculum_to_blueprint(client_db):
    from backend.models import Curriculum, Section
    client, db = client_db
    main_id, green_id, tt_id, sec_id = _seed_pediatrics(db)

    resp = client.delete(f"/api/topic-trees/{tt_id}")
    assert resp.status_code in (200, 204), resp.text

    db.expunge_all()
    # green add is gone (check by name/color — SQLite may reuse the deleted rowid),
    # its section is gone, and the blueprint children are in.
    assert db.get(Section, sec_id) is None
    assert db.query(Curriculum).filter_by(name="My Added Topic").count() == 0
    assert db.query(Curriculum).filter_by(color="green").count() == 0
    children = db.query(Curriculum).filter_by(parent_id=main_id).all()
    assert len(children) == 12  # pediatrics-2025.json has 12 sections
    assert any("Cardiovascular" in c.name for c in children)


def test_delete_does_not_reset_when_another_document_remains(client_db):
    from backend.models import Curriculum, TopicTree
    client, db = client_db
    main_id, green_id, tt_id, _sec_id = _seed_pediatrics(db)
    # A second document still hangs off the same main topic.
    db.add(TopicTree(name="Peds Doc 2", slug="peds-doc-2", curriculum_id=main_id)); db.commit()

    resp = client.delete(f"/api/topic-trees/{tt_id}")
    assert resp.status_code in (200, 204), resp.text

    db.expunge_all()
    # No reset — the green add survives because another document still uses the topic.
    assert db.get(Curriculum, green_id) is not None
