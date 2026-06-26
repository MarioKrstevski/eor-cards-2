"""Orphan-sweep coverage: a reconcile-gated ProcessingJob (pipeline_step ==
'awaiting_reconcile') must survive a server restart, while a normal in-flight
job must be marked failed."""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import backend.main as main_mod
from backend.db import Base
from backend.models import TopicTree, Upload, ProcessingJob, JobStatus


@pytest.fixture
def test_session(tmp_path, monkeypatch):
    db_file = tmp_path / "sweep.db"
    engine = create_engine(
        f"sqlite:///{db_file}", connect_args={"check_same_thread": False}
    )
    Base.metadata.create_all(bind=engine)
    TestSession = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    # _sweep_orphaned_jobs() opens its own session via the module-level SessionLocal.
    monkeypatch.setattr(main_mod, "SessionLocal", TestSession)
    db = TestSession()
    try:
        yield db, TestSession
    finally:
        db.close()
        engine.dispose()


def _seed_upload(db) -> Upload:
    tt = TopicTree(name="Emergency Medicine", slug="emergency-medicine")
    db.add(tt)
    db.flush()
    upload = Upload(topic_tree_id=tt.id, original_name="doc.docx", filename="doc.docx")
    db.add(upload)
    db.flush()
    return upload


def test_awaiting_reconcile_survives_sweep(test_session):
    db, _ = test_session

    upload = _seed_upload(db)
    parked = ProcessingJob(
        upload_id=upload.id, status=JobStatus.running, pipeline_step="awaiting_reconcile"
    )
    inflight = ProcessingJob(
        upload_id=upload.id, status=JobStatus.running, pipeline_step="parsing"
    )
    db.add_all([parked, inflight])
    db.commit()
    parked_id, inflight_id = parked.id, inflight.id

    main_mod._sweep_orphaned_jobs()

    db.expire_all()
    assert db.get(ProcessingJob, parked_id).status == JobStatus.running
    swept = db.get(ProcessingJob, inflight_id)
    assert swept.status == JobStatus.failed
    assert swept.error_message == "Interrupted by server restart"
