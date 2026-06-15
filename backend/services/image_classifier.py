"""Classify images using Claude Vision and extract text when needed."""
from __future__ import annotations
import logging
import anthropic
from backend.config import DEFAULT_PROCESSING_MODEL, resolve_model, effort_kwargs

logger = logging.getLogger(__name__)


def classify_image(
    client: anthropic.Anthropic,
    data_uri: str,
    alt_text_hint: str | None = None,
    model: str = DEFAULT_PROCESSING_MODEL,
) -> dict:
    """Classify an image and optionally extract text using Claude Vision.

    Args:
        client: Anthropic client
        data_uri: Base64 data URI of the image
        alt_text_hint: Alt text hint (e.g., "EXTRACT", "REFERENCE")
        model: Model to use for classification

    Returns:
        {
            "category": "decorative" | "diagram" | "chart" | "table_image" | "unclear",
            "extracted_text": str | None,
            "usage": {"input_tokens": int, "output_tokens": int}
        }
    """
    # Parse the data URI
    if not data_uri.startswith("data:"):
        return {"category": "unclear", "extracted_text": None, "usage": {"input_tokens": 0, "output_tokens": 0}}

    # Extract media type and base64 data
    header, b64_data = data_uri.split(",", 1)
    media_type = header.split(";")[0].replace("data:", "")

    prompt = """Analyze this image and classify it into one of these categories:
- decorative: logos, borders, purely decorative elements
- diagram: anatomical diagrams, flowcharts, process diagrams
- chart: graphs, bar charts, pie charts, data visualizations
- table_image: images of tables with data
- unclear: cannot determine

Also, if the image contains readable text or data, extract it verbatim.

Output format:
CATEGORY: <category>
EXTRACTED_TEXT: <text or NONE>"""

    if alt_text_hint:
        prompt += f"\n\nHint from document: {alt_text_hint}"

    try:
        response = client.messages.create(
            model=resolve_model(model)[0],
            **effort_kwargs(model),
            max_tokens=2048,
            temperature=0,
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": b64_data,
                        },
                    },
                    {"type": "text", "text": prompt},
                ],
            }],
        )

        raw = next((b.text for b in response.content if b.type == "text"), "").strip()
        usage = {
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
        }

        # Parse output
        category = "unclear"
        extracted_text = None

        for line in raw.split("\n"):
            line = line.strip()
            if line.startswith("CATEGORY:"):
                cat = line.split(":", 1)[1].strip().lower()
                if cat in ("decorative", "diagram", "chart", "table_image", "unclear"):
                    category = cat

        # Take everything after EXTRACTED_TEXT: (extraction is often multi-line),
        # but treat a leading NONE token as no extraction — previously
        # "NONE\n<commentary>" failed the exact match and stored commentary
        # as medical content.
        if "EXTRACTED_TEXT:" in raw:
            text_part = raw.split("EXTRACTED_TEXT:", 1)[1].strip()
            if text_part and not text_part.upper().startswith("NONE"):
                extracted_text = text_part

        if response.stop_reason == "max_tokens" and extracted_text:
            logger.warning("Image text extraction truncated at max_tokens")
            extracted_text += "\n[⚠ extraction truncated — verify against original image]"

        return {"category": category, "extracted_text": extracted_text, "usage": usage}

    except Exception as e:
        logger.exception("Image classification failed")
        return {
            "category": "unclear",
            "extracted_text": None,
            "usage": {"input_tokens": 0, "output_tokens": 0},
        }
