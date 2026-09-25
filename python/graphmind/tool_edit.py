"""Editing a held tool call's arguments (0.6.0, contract C2): the pieces the
tool wrappers share. Port of the parts of ``packages/client/src/tool-edit.ts``
a Python tool needs.

* :func:`tool_gate_options`: the keyword options for one tool gate —
  ``editable`` + ``validate_input`` when the call's arguments can take an edit,
  ``result`` at the ``after`` gate. Empty while detached, so the detached gate
  path allocates nothing new.
* :func:`tool_args_validator`: :func:`~graphmind.edit_input.merge_tool_input`
  (top-level keys replace the live ones; a hidden input takes only a full
  replacement) followed by the tool's own check. The verdict's ``value`` is
  what the call then runs with.
* :func:`signature_check`: a plain Python function carries no schema, but its
  SIGNATURE says which arguments exist and which are required — the edit must
  be a call the function can receive: every key a parameter, every required
  parameter present, ``*args`` a list, ``**kwargs`` an object. Types are not
  checked: as with a plain TypeScript function, the function itself is the
  validator, and a raise lands on the error gate.
* :func:`call_arguments`: an ``{parameter: value}`` mapping back into the
  ``(args, kwargs)`` of a real call.

Messages name the field and the problem and never quote a value.
"""

from __future__ import annotations

import inspect
import json
from collections.abc import Callable, Mapping
from typing import Any

from .edit_input import (
    InputValidation,
    ValidateInput,
    ValidateInputContext,
    accept,
    merge_tool_input,
    refuse,
    sanitize_short_text,
)
from .gate import GateDecision

#: A check of merged tool arguments; ``value`` on success is what runs.
SchemaCheck = Callable[[Any, ValidateInputContext], InputValidation]

GENERIC_SCHEMA_MESSAGE = "the edited arguments do not match the tool's parameters"

_UNSET: Any = object()
_MAX_KEY_IN_MESSAGE = 48

_VAR_POSITIONAL = inspect.Parameter.VAR_POSITIONAL
_VAR_KEYWORD = inspect.Parameter.VAR_KEYWORD
_POSITIONAL_ONLY = inspect.Parameter.POSITIONAL_ONLY


class ToolEdit:
    """What a tool gate can do with an edit: the arguments the call runs with
    now (the host's, or the last accepted edit) and how to check an edit of them."""

    __slots__ = ("args", "check")

    def __init__(self, args: Any, check: SchemaCheck | None = None) -> None:
        self.args = args
        self.check = check


def tool_args_validator(live: Any, check: SchemaCheck | None = None) -> ValidateInput:
    """The validator for a tool gate: merge the proposed arguments into the live
    ones, then run ``check`` on the result when there is one. ``context`` MUST
    reach the merge: under a hidden input the edit is judged as a full
    replacement, never completed from the hidden live values."""

    def validate(proposed: Any, context: ValidateInputContext) -> Any:
        merged = merge_tool_input(live, proposed, context)
        if merged.get("ok") is not True or check is None:
            return merged
        return check(merged["value"], context)

    return validate


def tool_gate_options(
    session: Any,
    edit: ToolEdit | Callable[[], ToolEdit | None] | None,
    after: Any = _UNSET,
) -> dict[str, Any]:
    """Keyword options for one tool gate (``session.gate(point, node, **options)``).

    ``edit`` makes the pause editable (the session still offers it only when
    the app and the debugger both enabled edits) — pass a function to have it
    evaluated only while attached; ``after`` carries the call's result to the
    after-gate detectors. Empty when detached — the gate is a no-op then, and
    nothing is evaluated."""
    try:
        if not session.attached:
            return {}
    except Exception:
        return {}
    plan = edit() if callable(edit) else edit
    options: dict[str, Any] = {}
    if plan is not None:
        options["editable"] = True
        options["validate_input"] = tool_args_validator(plan.args, plan.check)
    if after is not _UNSET:
        options["result"] = after
    return options


def edited_args(decision: GateDecision) -> tuple[bool, Any]:
    """``(True, args)`` when the decision carries accepted edited arguments —
    ``continue`` at ``before``, ``retry`` at ``after`` / ``error`` — else
    ``(False, None)`` (the call keeps its arguments)."""
    if decision.action in ("continue", "retry") and decision.has_input:
        return True, decision.input
    return False, None


# -- a Python function's signature as the schema of its arguments ------------------


def _short_key(key: str) -> str:
    return key if len(key) <= _MAX_KEY_IN_MESSAGE else key[: _MAX_KEY_IN_MESSAGE - 1] + "…"


def _field(name: str) -> str:
    return f"field {json.dumps(_short_key(name), ensure_ascii=False)}"


def _type_name(value: Any) -> str:
    """A value's JSON type, for messages. Never the value."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, (list, tuple)):
        return "array"
    if isinstance(value, Mapping):
        return "object"
    return "a value"


def _problem(text: str) -> InputValidation:
    return refuse("schema", sanitize_short_text(text) or GENERIC_SCHEMA_MESSAGE)


def call_arguments(
    signature: inspect.Signature, arguments: Mapping[str, Any]
) -> tuple[tuple[Any, ...], dict[str, Any]]:
    """The ``(args, kwargs)`` that call a function of this signature with these
    ``{parameter: value}`` arguments (the recorded shape: ``*args`` a list under
    its name, ``**kwargs`` a mapping under its). Parameters left out take their
    defaults. Raises when the mapping cannot be such a call."""
    ordered = {name: arguments[name] for name in signature.parameters if name in arguments}
    bound = inspect.BoundArguments(signature, ordered)  # type: ignore[arg-type]
    bound.apply_defaults()
    return tuple(bound.args), dict(bound.kwargs)


def signature_check(signature: inspect.Signature) -> SchemaCheck:
    """A :data:`SchemaCheck` from a function's signature (see the module docstring)."""
    params = signature.parameters

    def check(value: Any, context: ValidateInputContext | None = None) -> InputValidation:
        try:
            if not isinstance(value, dict):
                return refuse("schema", GENERIC_SCHEMA_MESSAGE)
            for key in value:
                if not isinstance(key, str) or key not in params:
                    return _problem(f"{_field(str(key))} is not a parameter of this tool")
            for name, param in params.items():
                if param.kind is _VAR_POSITIONAL:
                    if name in value and not isinstance(value[name], (list, tuple)):
                        return _problem(
                            f"{_field(name)} must be array, got {_type_name(value[name])}"
                        )
                    continue
                if param.kind is _VAR_KEYWORD:
                    if name not in value:
                        continue
                    extra = value[name]
                    if not isinstance(extra, Mapping) or not all(
                        isinstance(key, str) for key in extra
                    ):
                        return _problem(f"{_field(name)} must be object, got {_type_name(extra)}")
                    for key in extra:
                        other = params.get(key)
                        if other is not None and other.kind is not _POSITIONAL_ONLY:
                            repeated = json.dumps(_short_key(key), ensure_ascii=False)
                            return _problem(f"{_field(name)} repeats the parameter {repeated}")
                    continue
                if param.default is inspect.Parameter.empty and name not in value:
                    return _problem(f"{_field(name)} is required")
            call_arguments(signature, value)
            return accept(value)
        except Exception:
            return refuse("schema", GENERIC_SCHEMA_MESSAGE)

    return check


def bind_arguments(
    signature: inspect.Signature | None, args: Any, kwargs: Any
) -> dict[str, Any] | None:
    """The call's arguments as the edit rule sees them — ``{parameter: value}``
    with defaults applied, exactly what the tool node records — or ``None``
    when the call cannot take an edit (no signature, or arguments that do not
    bind even partially)."""
    if signature is None:
        return None
    try:
        bound = signature.bind_partial(*args, **kwargs)
        bound.apply_defaults()
        return dict(bound.arguments)
    except Exception:
        return None


__all__ = [
    "GENERIC_SCHEMA_MESSAGE",
    "SchemaCheck",
    "ToolEdit",
    "bind_arguments",
    "call_arguments",
    "edited_args",
    "signature_check",
    "tool_args_validator",
    "tool_gate_options",
]
