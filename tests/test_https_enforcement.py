"""HTTPS enforcement in the SDK HTTP clients and the clients built on them."""

import pytest


class TestSDKHTTPSEnforcement:
    """Tests for HTTPS enforcement in the SDK."""

    def test_http_url_rejected_by_default(self):
        """HTTP URLs should be rejected by default."""
        from gurucloud_kb._http import HTTPClient

        with pytest.raises(ValueError, match="HTTPS"):
            HTTPClient(
                base_url="http://example.com",
                api_key="kb_test_key",
            )

    def test_https_url_accepted(self):
        """HTTPS URLs should be accepted."""
        from gurucloud_kb._http import HTTPClient

        # Should not raise
        client = HTTPClient(
            base_url="https://www.gurucloudai.com",
            api_key="kb_test_key",
        )
        assert client._base_url == "https://www.gurucloudai.com"
        client.close()

    def test_http_allowed_with_flag(self):
        """HTTP should be allowed when allow_insecure=True."""
        from gurucloud_kb._http import HTTPClient

        client = HTTPClient(
            base_url="http://localhost:5001",
            api_key="kb_test_key",
            allow_insecure=True,
        )
        assert client._base_url == "http://localhost:5001"
        client.close()

    def test_async_http_url_rejected_by_default(self):
        """HTTP URLs should be rejected by default in async client."""
        from gurucloud_kb._async_http import AsyncHTTPClient

        with pytest.raises(ValueError, match="HTTPS"):
            AsyncHTTPClient(
                base_url="http://example.com",
                api_key="kb_test_key",
            )

    def test_async_https_url_accepted(self):
        """HTTPS URLs should be accepted in async client."""
        from gurucloud_kb._async_http import AsyncHTTPClient

        client = AsyncHTTPClient(
            base_url="https://www.gurucloudai.com",
            api_key="kb_test_key",
        )
        assert client._base_url == "https://www.gurucloudai.com"

    def test_async_http_allowed_with_flag(self):
        """HTTP should be allowed in async client when allow_insecure=True."""
        from gurucloud_kb._async_http import AsyncHTTPClient

        client = AsyncHTTPClient(
            base_url="http://localhost:5001",
            api_key="kb_test_key",
            allow_insecure=True,
        )
        assert client._base_url == "http://localhost:5001"

    def test_client_propagates_allow_insecure(self):
        """GuruCloudClient should propagate allow_insecure to HTTPClient."""
        from gurucloud_kb import GuruCloudClient

        with pytest.raises(ValueError, match="HTTPS"):
            GuruCloudClient(api_key="kb_test", base_url="http://example.com")

        # Should work with allow_insecure=True
        client = GuruCloudClient(
            api_key="kb_test",
            base_url="http://localhost:5001",
            allow_insecure=True,
        )
        client.close()

    def test_async_client_propagates_allow_insecure(self):
        """AsyncGuruCloudClient should propagate allow_insecure."""
        from gurucloud_kb import AsyncGuruCloudClient

        with pytest.raises(ValueError, match="HTTPS"):
            AsyncGuruCloudClient(api_key="kb_test", base_url="http://example.com")

        # Should work with allow_insecure=True
        client = AsyncGuruCloudClient(
            api_key="kb_test",
            base_url="http://localhost:5001",
            allow_insecure=True,
        )
