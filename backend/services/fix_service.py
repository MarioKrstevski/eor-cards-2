import json
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from backend.db import SessionLocal
from backend.models import Card, FixBatch, FixProposal, ReviewMarkType, Section, AIUsageLog, utcnow
from backend.config import ANTHROPIC_API_KEY, compute_cost
import anthropic

logger = logging.getLogger(__name__)

client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

SYSTEM_PROMPT = """You are a medical flashcard quality reviewer. You receive a cloze-style flashcard and instructions for fixing a specific issue.

Your job:
1. Read the card and the issue description carefully
2. Apply the fix as instructed
3. Return a JSON object with your decision

Cloze format rules (MUST follow):
- Cloze deletions use {{c1::term}} syntax
- Use <b>HTML bold</b> for emphasis, never **markdown bold**
- Preserve the medical accuracy of the original

Output ONLY valid JSON, no other text. Schema:
{
  "action": "edit" | "keep" | "delete" | "split",
  "front_html": "...",      // required if action is edit; the fixed card content
  "extra": "..." | null,    // if action is edit; updated additional context
  "new_cards": [            // required if action is split
    {"front_html": "...", "extra": "..." | null, "tags": [...]}
  ]
}

- action "keep": card is fine as-is, return only {"action": "keep"}
- action "delete": card should be removed, return only {"action": "delete"}
- action "edit": provide the corrected front_html (and extra if changed)
- action "split": provide the array of new cards that replace this one
"""


def _fix_one_card(card_id: int, mark_type_name: str, prompt: str, model: str, batch_id: int) -> dict:
    """Fix one card and save proposal. Returns result dict."""
    db = SessionLocal()
    try:
        card = db.get(Card, card_id)
        if not card:
            return {"card_id": card_id, "error": "not found"}

        section = db.get(Section, card.section_id)
        section_heading = section.heading if section else ""

        user_msg = f"""Issue type: {mark_type_name}
Reviewer instruction: {prompt}

Card to fix:
Front: {card.front_html}
Extra: {card.extra or '(none)'}
Tags: {', '.join(card.tags)}
Section: {section_heading}

Respond with JSON only."""

        response = client.messages.create(
            model=model,
            max_tokens=1500,
            temperature=0,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_msg}],
        )
        raw = response.content[0].text.strip()

        # Parse JSON
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            # Try to extract JSON from response
            start = raw.find('{')
            end = raw.rfind('}') + 1
            if start >= 0 and end > start:
                data = json.loads(raw[start:end])
            else:
                raise ValueError(f"Could not parse JSON from: {raw[:200]}")

        action = data.get("action", "keep")

        # Log usage
        cost = compute_cost(model, response.usage.input_tokens, response.usage.output_tokens)
        db.add(AIUsageLog(
            operation="card_fix",
            model=model,
            input_tokens=response.usage.input_tokens,
            output_tokens=response.usage.output_tokens,
            cost_usd=cost,
            card_id=card_id,
            job_id=batch_id,
        ))

        # Save proposal
        proposal = FixProposal(
            batch_id=batch_id,
            original_card_id=card_id,
            ai_action=action,
            proposed_front_html=data.get("front_html") if action == "edit" else None,
            proposed_extra=data.get("extra") if action == "edit" else None,
            new_cards_json=data.get("new_cards") if action == "split" else None,
        )
        db.add(proposal)

        # Update batch progress
        batch = db.get(FixBatch, batch_id)
        if batch:
            batch.processed_cards += 1
        db.commit()

        return {"card_id": card_id, "action": action}

    except Exception as e:
        logger.error(f"fix_one_card error card={card_id}: {e}")
        # Save error proposal as keep
        try:
            proposal = FixProposal(
                batch_id=batch_id,
                original_card_id=card_id,
                ai_action="keep",
                proposed_front_html=None,
                proposed_extra=None,
                new_cards_json=None,
            )
            db.add(proposal)
            batch = db.get(FixBatch, batch_id)
            if batch:
                batch.processed_cards += 1
            db.commit()
        except Exception:
            pass
        return {"card_id": card_id, "error": str(e)}
    finally:
        db.close()


def run_fix_batch(batch_id: int, card_ids: list[int]) -> None:
    """Background thread: run AI fix for specified card IDs."""
    db = SessionLocal()
    try:
        batch = db.get(FixBatch, batch_id)
        if not batch:
            return
        mark_type = db.get(ReviewMarkType, batch.mark_type_id) if batch.mark_type_id else None
        mark_name = mark_type.name if mark_type else "Issue"
        prompt = batch.prompt
        model = batch.model
        batch.total_cards = len(card_ids)
        batch.processed_cards = 0
        batch.status = "running"
        db.commit()
    finally:
        db.close()

    if not card_ids:
        db2 = SessionLocal()
        b = db2.get(FixBatch, batch_id)
        if b:
            b.status = "done"
            b.finished_at = utcnow()
        db2.commit()
        db2.close()
        return

    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {
            executor.submit(_fix_one_card, cid, mark_name, prompt, model, batch_id): cid
            for cid in card_ids
        }
        for future in as_completed(futures):
            try:
                future.result()
            except Exception as e:
                logger.error(f"Fix batch {batch_id} card error: {e}")

    db3 = SessionLocal()
    b = db3.get(FixBatch, batch_id)
    if b:
        b.status = "done"
        b.finished_at = utcnow()
    db3.commit()
    db3.close()
