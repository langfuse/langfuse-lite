"""pytest fixtures (registered automatically when langfuse-lite is installed).

    def test_my_agent(langfuse_lite_env):
        run_my_agent()                      # traced with the Langfuse SDK as usual
        assert "my-agent" in langfuse_lite_env.cli("traces")

``langfuse_lite``: one server per test session, temporary database.
``langfuse_lite_env``: the same server, with LANGFUSE_* set for the test.
"""
import pytest

from . import serve


@pytest.fixture(scope="session")
def langfuse_lite():
    with serve() as lite:
        yield lite


@pytest.fixture
def langfuse_lite_env(langfuse_lite, monkeypatch):
    for key, value in langfuse_lite.env.items():
        monkeypatch.setenv(key, value)
    yield langfuse_lite
