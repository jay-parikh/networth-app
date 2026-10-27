"""A tiny stand-in for the `requests` package, for the browser build.

The NetWorth fetchers use only `requests.Session().get(url, headers=,
timeout=)`, the response's status_code / content / text / json() /
raise_for_status(), and `requests.RequestException`. In the browser every GET
goes through one JavaScript function, `nwHttp(url, headers_json, timeout_ms)`,
which the web worker implements with a synchronous XMLHttpRequest to the
site's own proxy (browsers cannot fetch AMFI/BSE/NSE directly - no CORS).
The Node test harness implements the same function with curl.

nwHttp returns {status, body: Uint8Array, url, error}. A non-empty `error`
means the request never produced a response (offline, proxy down, timeout).
"""
from __future__ import annotations

import json as _json

__version__ = "2.31.0-nwshim"


class RequestException(IOError):
    pass


class HTTPError(RequestException):
    def __init__(self, msg="", response=None):
        super().__init__(msg)
        self.response = response


class ConnectionError(RequestException):  # noqa: A001 - mirrors requests
    pass


class Timeout(RequestException):
    pass


class exceptions:  # noqa: N801 - requests.exceptions.X spelling
    RequestException = RequestException
    HTTPError = HTTPError
    ConnectionError = ConnectionError
    Timeout = Timeout


class Response:
    def __init__(self, status_code: int, content: bytes, url: str,
                 headers: dict | None = None):
        self.status_code = status_code
        self.content = content
        self.url = url
        self.headers = headers or {}
        self.encoding = None

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 400

    @property
    def text(self) -> str:
        if self.encoding:
            return self.content.decode(self.encoding, errors="replace")
        try:
            return self.content.decode("utf-8")
        except UnicodeDecodeError:
            return self.content.decode("latin-1")

    def json(self):
        return _json.loads(self.text)

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise HTTPError(f"{self.status_code} error for url: {self.url}",
                            response=self)


# Pages the fetchers GET only to collect NSE cookies. Through the proxy each
# request is independent (the proxy does its own warm-up), so these would be
# wasted round trips of several hundred kB - answer them locally.
_WARMUP_PAGES = {
    "https://www.nseindia.com/",
    "https://www.nseindia.com",
    "https://www.nseindia.com/all-reports",
}

# Set by the web app: when False every request fails at once (offline mode,
# used for imports and recalculations that must not touch the network).
online = True


def _timeout_ms(timeout) -> int:
    if timeout is None:
        return 60000
    if isinstance(timeout, (tuple, list)):
        return int(sum(t or 0 for t in timeout) * 1000) or 60000
    return int(timeout * 1000)


class Session:
    def __init__(self):
        self.headers: dict = {}
        self.cookies: dict = {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def close(self) -> None:
        pass

    def get(self, url, params=None, headers=None, timeout=None, **_kw):
        return self.request("GET", url, params=params, headers=headers,
                            timeout=timeout)

    def request(self, method, url, params=None, headers=None, timeout=None,
                **_kw):
        if method.upper() != "GET":
            raise RequestException("only GET is supported in the web app")
        if params:
            from urllib.parse import urlencode
            url = url + ("&" if "?" in url else "?") + urlencode(params)
        if url in _WARMUP_PAGES:
            return Response(200, b"", url)
        if not online:
            raise ConnectionError("offline")
        hdrs = {**self.headers, **(headers or {})}
        from js import nwHttp  # provided by the worker / test harness
        res = nwHttp(url, _json.dumps(hdrs), _timeout_ms(timeout))
        err = str(res.error or "")
        if err:
            if "timeout" in err.lower():
                raise Timeout(err)
            raise ConnectionError(err)
        body = bytes(res.body.to_py()) if res.body is not None else b""
        return Response(int(res.status), body, str(res.url or url))


def get(url, **kw):
    return Session().get(url, **kw)
