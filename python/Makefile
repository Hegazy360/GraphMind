# GraphMind Python SDK — development tasks.
# Everything runs inside python/.venv so the host interpreter stays untouched.

PY      ?= python3
VENV    := .venv
BIN     := $(VENV)/bin
PYTHON  := $(BIN)/python

.DEFAULT_GOAL := help
.PHONY: help install test test-verbose lint format typecheck check build clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

$(BIN)/python:
	$(PY) -m venv $(VENV)
	$(PYTHON) -m pip install --upgrade pip

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
