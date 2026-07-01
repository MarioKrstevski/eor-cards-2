"""Renaming a curriculum node must cascade the new path to Sections pointing at
the node or any descendant (curriculum_topic_path was previously left stale)."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db import Base
from backend.models import Curriculum, TopicTree, Section
from backend.routers.curriculum import rename_node, CurriculumUpdate


@pytest.fixture
def db(tmp_path):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'rename.db'}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(bind=engine)
    TestSession = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    session = TestSession()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def test_rename_cascades_to_sections(db):
    root = Curriculum(name="Emergency Medicine", level=0,
                      path="Emergency Medicine", version="v1")
    db.add(root)
    db.flush()
    mid = Curriculum(name="Cardiology", level=1, parent_id=root.id,
                     path="Emergency Medicine > Cardiology", version="v1")
    db.add(mid)
    db.flush()
    leaf = Curriculum(name="Heart Failure", level=2, parent_id=mid.id,
                      path="Emergency Medicine > Cardiology > Heart Failure",
                      version="v1")
    db.add(leaf)
    db.flush()

    tt = TopicTree(name="Emergency Medicine", slug="emergency-medicine",
                   curriculum_id=root.id)
    db.add(tt)
    db.flush()
    section = Section(
        topic_tree_id=tt.id, heading="Heart Failure", slug="heart-failure",
        content_text="x", curriculum_topic_id=leaf.id,
        curriculum_topic_path=leaf.path,
    )
    db.add(section)
    db.commit()

    rename_node(mid.id, CurriculumUpdate(name="Cardiovascular"), db)

    db.expire_all()
    assert db.get(Curriculum, leaf.id).path == \
        "Emergency Medicine > Cardiovascular > Heart Failure"
    assert db.get(Section, section.id).curriculum_topic_path == \
        "Emergency Medicine > Cardiovascular > Heart Failure"

    # Renaming the leaf itself also updates its section.
    rename_node(leaf.id, CurriculumUpdate(name="CHF"), db)
    db.expire_all()
    assert db.get(Section, section.id).curriculum_topic_path == \
        "Emergency Medicine > Cardiovascular > CHF"
