# GraphMind Python SDK — development tasks.
# Everything runs inside python/.venv so the host interpreter stays untouched.

# The package needs Python >= 3.10 and macOS ships 3.9 as `python3`, so pick
# an interpreter that qualifies: `make PY=...` beats everything; otherwise
# `uv` (its interpreters are user-level and never touch the system one),
# then the newest `python3.X` on PATH, then plain `python3`. Nothing here
# installs or changes a system interpreter.
PY      ?= $(shell for c in python3.14 python3.13 python3.12 python3.11 python3.10 python3; do \
             if command -v $$c >/dev/null 2>&1 && $$c -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then echo $$c; exit 0; fi; \
           done; echo python3)
UV      := $(shell command -v uv 2>/dev/null)
VENV    := .venv
BIN     := $(VENV)/bin
PYTHON  := $(BIN)/python

.DEFAULT_GOAL := help
.PHONY: help install test test-verbose lint format typecheck check build clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

$(BIN)/python:
ifneq ($(UV),)
	$(UV) venv --quiet --python '>=3.10' $(VENV)
	$(UV) pip install --quiet --python $(PYTHON) pip
else
	@$(PY) -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' || \
	  { echo "need Python >= 3.10: install uv (https://docs.astral.sh/uv/) or pass PY=python3.12"; exit 1; }
	$(PY) -m venv $(VENV)
	$(PYTHON) -m pip install --upgrade pip
endif

install: $(BIN)/python ## Create the venv and install the package + dev deps (editable)
	$(PYTHON) -m pip install -e ".[dev]" pytest-timeout

test: ## Run the test suite (no network, no API keys)
	$(PYTHON) -m pytest -q --timeout=60 --timeout-method=thread

test-verbose: ## Run the test suite with per-test output
	$(PYTHON) -m pytest -vv -s --timeout=60 --timeout-method=thread

lint: ## Lint and check formatting
	$(BIN)/ruff check .
	$(BIN)/ruff format --check .

format: ## Apply formatting and safe lint fixes
	$(BIN)/ruff check --fix .
	$(BIN)/ruff format .

typecheck: ## Type-check the package
	$(BIN)/mypy

check: lint typecheck test ## Everything CI runs

build: ## Build the wheel and sdist into dist/
	rm -rf dist
	$(PYTHON) -m build
	@ls -la dist

clean: ## Remove build artifacts and caches
	rm -rf dist build *.egg-info .pytest_cache .mypy_cache .ruff_cache
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
