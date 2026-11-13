from __future__ import annotations

import io
import json
import logging
from dataclasses import dataclass
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any, cast

import jsonschema
import pytest
import yaml
from jupyter_events.logger import EventLogger

from jupytergis_core.events import EVENT_SCHEMAS, register_event_schemas

if TYPE_CHECKING:
    from jupyter_server.serverapp import ServerApp

EVENTS_SCHEMA_NAMESPACE = "https://schema.jupytergis.org/events"
DOCUMENT_SCHEMA_ID = f"{EVENTS_SCHEMA_NAMESPACE}/document/v1"
LAYER_SCHEMA_ID = f"{EVENTS_SCHEMA_NAMESPACE}/layer/v1"
VIEWPORT_SCHEMA_ID = f"{EVENTS_SCHEMA_NAMESPACE}/viewport/v1"
SOURCE_SCHEMA_ID = f"{EVENTS_SCHEMA_NAMESPACE}/source/v1"
MODE_SCHEMA_ID = f"{EVENTS_SCHEMA_NAMESPACE}/mode/v1"
NOTEBOOK_SCHEMA_ID = f"{EVENTS_SCHEMA_NAMESPACE}/notebook/v1"
FRONTEND_ID = "a4d7ce2a-58ee-4db9-a42b-3f6836ed339e"


def _fake_server_app(*, event_logger: EventLogger) -> ServerApp:
    return cast("ServerApp", SimpleNamespace(event_logger=event_logger))


def _make_logger() -> tuple[EventLogger, io.StringIO]:
    sink = io.StringIO()
    logger = EventLogger(handlers=[logging.StreamHandler(sink)])
    register_event_schemas(server_app=_fake_server_app(event_logger=logger))
    return logger, sink


@dataclass(frozen=True)
class EventSchemaCase:
    """A JupyterGIS event schema paired with one event that must validate against it."""

    id: str
    event: dict[str, Any]


EVENT_SCHEMA_CASES: tuple[EventSchemaCase, ...] = (
    EventSchemaCase(
        id=DOCUMENT_SCHEMA_ID,
        event={
            "subject": "42",
            "verb": "opened",
            "object": {
                "document_path": "example.jgis",
            },
        },
    ),
    EventSchemaCase(
        id=LAYER_SCHEMA_ID,
        event={
            "subject": "42",
            "verb": "added",
            "object": {
                "document_path": "earthquakes.jgis",
                "layer_id": "layer-1",
                "new": {
                    "type": "VectorLayer",
                    "name": "earthquakes",
                    "visible": True,
                    "parameters": {
                        "source": "source-1",
                        "opacity": 1,
                    },
                },
            },
        },
    ),
    EventSchemaCase(
        id=VIEWPORT_SCHEMA_ID,
        event={
            "subject": "42",
            "verb": "moved",
            "object": {
                "document_path": "example.jgis",
                "new": {
                    "coordinates": {"x": 260_000.0, "y": 6_250_000.0},
                    "zoom": 12,
                    "extent": [250_000.0, 6_240_000.0, 270_000.0, 6_260_000.0],
                },
            },
        },
    ),
    EventSchemaCase(
        id=SOURCE_SCHEMA_ID,
        event={
            "subject": "42",
            "verb": "updated",
            "local": True,
            "object": {
                "document_path": "maps/city.jGIS",
                "source_id": "source-1",
                "old": {
                    "id": "source-1",
                    "type": "GeoJSONSource",
                    "path": "../data/a.geojson",
                    "resolved_path": "data/a.geojson",
                },
                "new": {
                    "id": "source-1",
                    "type": "GeoJSONSource",
                    "path": "../data/b.geojson",
                    "resolved_path": "data/b.geojson",
                },
            },
        },
    ),
    EventSchemaCase(
        id=NOTEBOOK_SCHEMA_ID,
        event={
            "verb": "requested",
            "time": "2026-11-12T18:00:00.000Z",
            "object": {
                "document_path": "analysis.ipynb",
                "kernel_id": "4f0e7f38-6f1b-4c1a-a7a4-9f2c86c3f2a1",
                "request_id": "c2a0b4b2-1d1e4f0f9e4f6c2a5b3d1e7f_1_1",
                "cell_id": "0b8e6e2c-7d55-4f41-8f12-25a3f0a6d5a0",
            },
        },
    ),
    EventSchemaCase(
        id=MODE_SCHEMA_ID,
        event={
            "subject": "42",
            "verb": "changed",
            "time": "2026-11-12T18:00:00.000Z",
            "frontend_id": FRONTEND_ID,
            "focus_seq": 4,
            "object": {
                "document_path": "maps/city.jGIS",
                "mode": "identifying",
                "previous": "panning",
            },
        },
    ),
)


def test_every_schema_file_has_a_case() -> None:
    schema_ids = {
        yaml.safe_load(schema_path.read_text())["$id"] for schema_path in EVENT_SCHEMAS
    }

    assert schema_ids == {case.id for case in EVENT_SCHEMA_CASES}


@pytest.mark.parametrize(
    ["event_schema_case"],
    [
        pytest.param(case, id=case.id.removeprefix(EVENTS_SCHEMA_NAMESPACE + "/"))
        for case in EVENT_SCHEMA_CASES
    ],
)
def test_valid_events_emit(event_schema_case: EventSchemaCase) -> None:
    logger, sink = _make_logger()
    logger.emit(schema_id=event_schema_case.id, data=event_schema_case.event)
    assert event_schema_case.id in sink.getvalue()


def test_invalid_document_event_is_rejected() -> None:
    logger, _ = _make_logger()
    with pytest.raises(jsonschema.ValidationError, match="is a required property"):
        logger.emit(schema_id=DOCUMENT_SCHEMA_ID, data={"verb": "banana"})


def _document_focus_event(verb: str) -> dict[str, Any]:
    out = dict(
        subject="42",
        verb=verb,
        time="2026-10-31T18:00:00.000Z",
        frontend_id="a4d7ce2a-58ee-4db9-a42b-3f6836ed339e",
        focus_seq=1,
        object=dict(
            document_path="maps/city.jGIS",
            widget_id="map-a",
            reason="document_switch",
        ),
    )
    return out


@pytest.mark.parametrize("verb", ["opened", "closed"])
def test_legacy_document_events_emit(verb: str) -> None:
    logger, sink = _make_logger()
    event = dict(
        subject="42",
        verb=verb,
        object=dict(document_path=None),
    )
    logger.emit(schema_id=DOCUMENT_SCHEMA_ID, data=event)
    recorded = json.loads(sink.getvalue())
    assert recorded["verb"] == verb
    assert recorded["object"]["document_path"] is None


# trail: focus - validate actual logger output for both focus transitions.
@pytest.mark.parametrize("verb", ["activated", "deactivated"])
def test_document_focus_events_emit(verb: str) -> None:
    logger, sink = _make_logger()
    event = _document_focus_event(verb)
    logger.emit(schema_id=DOCUMENT_SCHEMA_ID, data=event)
    recorded = json.loads(sink.getvalue())
    for key, value in event.items():
        assert recorded[key] == value


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("verb", "focused"),
        ("focus_seq", 0),
        ("focus_seq", 1.5),
        ("focus_seq", True),
        ("frontend_id", "not-a-uuid"),
        ("time", "not-a-time"),
    ],
)
def test_invalid_focus_metadata_is_rejected(
    field: str,
    value: object,
) -> None:
    logger, _ = _make_logger()
    event = _document_focus_event("activated")
    event[field] = value
    with pytest.raises(jsonschema.ValidationError):
        logger.emit(schema_id=DOCUMENT_SCHEMA_ID, data=event)


def test_invalid_focus_reason_is_rejected() -> None:
    logger, _ = _make_logger()
    event = _document_focus_event("activated")
    event["object"]["reason"] = "switched_to_dataconnect"
    with pytest.raises(jsonschema.ValidationError):
        logger.emit(schema_id=DOCUMENT_SCHEMA_ID, data=event)


# trail: created - the first view of a new map reports created in place of opened.
def test_created_document_event_emits() -> None:
    logger, sink = _make_logger()
    event = dict(
        subject="42",
        verb="created",
        object=dict(document_path="untitled.jGIS"),
    )
    logger.emit(schema_id=DOCUMENT_SCHEMA_ID, data=event)
    recorded = json.loads(sink.getvalue())
    assert recorded["verb"] == "created"


# trail: resources - layer messages carry locality and the source's data reference.
@pytest.mark.parametrize(
    "source",
    [
        {
            "id": "source-1",
            "type": "GeoJSONSource",
            "path": "../data/crossings.geojson",
            "resolved_path": "data/crossings.geojson",
        },
        {
            "id": "source-2",
            "type": "RasterSource",
            "urls": ["https://tile.example.org/{z}/{x}/{y}.png"],
        },
        {
            "id": "source-3",
            "type": "GeoPackageVectorSource",
            "path": "data/roads.gpkg",
            "resolved_path": "data/roads.gpkg",
            "tables": ["roads", "bridges"],
        },
        {
            "id": "source-4",
            "type": "GeoJSONSource",
            "inline": {"field": "data", "size": 48213},
        },
    ],
)
def test_layer_local_and_source_emit(source: dict[str, Any]) -> None:
    logger, sink = _make_logger()
    event = dict(
        subject="42",
        verb="added",
        local=False,
        object=dict(
            document_path="maps/city.jGIS",
            layer_id="layer-1",
            new=dict(type="VectorLayer", name="crossings", parameters=dict(source=source["id"])),
            source=source,
        ),
    )
    logger.emit(schema_id=LAYER_SCHEMA_ID, data=event)
    recorded = json.loads(sink.getvalue())
    assert recorded["local"] is False
    assert recorded["object"]["source"] == source


@pytest.mark.parametrize(
    "reference",
    [
        {"id": "source-1", "type": "GeoJSONSource", "httpHeaders": "Authorization: x"},
        {"id": "source-1", "type": "GeoJSONSource", "inline": {"field": "data"}},
        {"id": "source-1"},
    ],
)
def test_source_reference_rejects_unknown_fields(reference: dict[str, Any]) -> None:
    logger, _ = _make_logger()
    event = dict(
        subject="42",
        verb="added",
        object=dict(document_path="maps/city.jGIS", source_id="source-1", new=reference),
    )
    with pytest.raises(jsonschema.ValidationError):
        logger.emit(schema_id=SOURCE_SCHEMA_ID, data=event)


def test_layer_local_must_be_boolean() -> None:
    logger, _ = _make_logger()
    event = dict(
        subject="42",
        verb="removed",
        local="yes",
        object=dict(document_path="maps/city.jGIS", layer_id="layer-1"),
    )
    with pytest.raises(jsonschema.ValidationError):
        logger.emit(schema_id=LAYER_SCHEMA_ID, data=event)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("verb", "selected"),
        ("mode", "measuring"),
        ("previous", None),
        ("focus_seq", 0),
        ("frontend_id", "not-a-uuid"),
    ],
)
def test_invalid_mode_is_rejected(
    field: str,
    value: object,
) -> None:
    logger, _ = _make_logger()
    event = next(case.event for case in EVENT_SCHEMA_CASES if case.id == MODE_SCHEMA_ID)
    event = json.loads(json.dumps(event))
    if field in ("mode", "previous"):
        event["object"][field] = value
    else:
        event[field] = value
    with pytest.raises(jsonschema.ValidationError):
        logger.emit(schema_id=MODE_SCHEMA_ID, data=event)



# trail: execution - a request without the kernel or its id cannot be joined to its execution.
@pytest.mark.parametrize("missing", ["kernel_id", "request_id"])
def test_notebook_request_needs_its_ids(missing: str) -> None:
    logger, _ = _make_logger()
    event = next(case.event for case in EVENT_SCHEMA_CASES if case.id == NOTEBOOK_SCHEMA_ID)
    event = json.loads(json.dumps(event))
    del event["object"][missing]
    with pytest.raises(jsonschema.ValidationError):
        logger.emit(schema_id=NOTEBOOK_SCHEMA_ID, data=event)
