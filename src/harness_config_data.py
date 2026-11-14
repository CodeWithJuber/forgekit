"""Read one small JSON/YAML mapping. No filesystem, network or constructors from the file."""
import json
import math
import sys


def mapping(pairs):
    obj = {}
    for key, value in pairs:
        if not isinstance(key, str) or key in {"__proto__", "constructor", "prototype", "<<"}:
            raise ValueError("Invalid harness configuration key")
        if key in obj:
            raise ValueError("Duplicate harness configuration key")
        obj[key] = value
    return obj


def validate(value, depth=0):
    if depth > 48:
        raise ValueError("Harness configuration nesting exceeds 48")
    if isinstance(value, (str, type(None), bool, int)):
        return
    if isinstance(value, float) and math.isfinite(value):
        return
    if isinstance(value, dict):
        for item in value.values():
            validate(item, depth + 1)
        return
    if isinstance(value, list):
        for item in value:
            validate(item, depth + 1)
        return
    raise ValueError("Harness configuration accepts plain JSON-compatible data")


def read(text):
    try:
        value = json.loads(text, object_pairs_hook=mapping)
    except json.JSONDecodeError:
        try:
            import yaml
        except ImportError:
            raise ValueError("Install PyYAML for YAML syntax or supply a JSON document")

        class Loader(yaml.SafeLoader):
            def construct_mapping(self, node, deep=False):
                return mapping(self.construct_pairs(node, deep=deep))

        depth = 0
        try:
            for n, event in enumerate(yaml.parse(text, Loader=Loader)):
                if event.__class__.__name__ in {"SequenceStartEvent", "MappingStartEvent"}:
                    depth += 1
                if event.__class__.__name__ in {"SequenceEndEvent", "MappingEndEvent"}:
                    depth -= 1
                if getattr(event, "anchor", None) or getattr(event, "tag", None):
                    raise ValueError("Harness YAML does not accept aliases, anchors or explicit tags")
                if n > 16000 or depth > 48:
                    raise ValueError("Harness YAML exceeds its structure limit")
            value = yaml.load(text, Loader=Loader)
        except yaml.YAMLError:
            raise ValueError("Invalid harness YAML")
    if not isinstance(value, dict):
        raise ValueError("Harness configuration must be one mapping")
    validate(value)
    return value


try:
    print(json.dumps({"value": read(sys.stdin.buffer.read().decode("utf-8-sig"))}, allow_nan=False))
except (ValueError, TypeError, RecursionError) as exc:
    print(json.dumps({"error": str(exc)[:180]}))
