from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from backend.config import DATABASE_URL
import os

os.makedirs(os.path.join(os.path.dirname(__file__), "..", "data"), exist_ok=True)

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_conn, _record):
    """Harden SQLite for two concurrent users.

    Default rollback-journal mode lets a single writer block readers and can
    surface 'database is locked' errors when two people work at once. WAL lets
    readers and a writer coexist; busy_timeout makes a second writer wait
    instead of erroring out. No-op for non-sqlite backends.
    """
    if not DATABASE_URL.startswith("sqlite"):
        return
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA busy_timeout=5000")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

class Base(DeclarativeBase):
    pass

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
