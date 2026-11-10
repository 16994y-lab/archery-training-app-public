"""One-use transport for the pinned Aliyun SMS SDK; no global SDK patches."""
from __future__ import annotations
import asyncio
import errno
import hashlib
import inspect
import json
import logging
import socket
import ssl
import sys
from importlib.metadata import version
from types import FunctionType, MethodType

HOST = 'dypnsapi.aliyuncs.com'
MAX_RESPONSE_BYTES = 65536
CONNECTION_STAGGER_SECONDS = 0.25
CONNECTION_ATTEMPT_SECONDS = 2.5
_LOGGER = logging.getLogger(__name__)
PINNED = {'alibabacloud-dypnsapi20170525': '2.0.0', 'alibabacloud-tea-openapi': '0.4.6',
          'darabonba-core': '1.0.9', 'aiohttp': '3.14.5', 'aiohappyeyeballs': '2.7.1'}
_SDK_FUNCTION_HASHES = (
    '703fdd674c1895ead72e3e04a75bb0a9293b94a818aed26a4b121bd3d3459b68',
    '891ccebac23d7b2b1221b674b5bfda142fd03c085ccb0fbe95e0125649f7130c',
    '9bfcb6e98c01fc78ed6d90da6eff7069d31620c3360f16fdad7f77ff630492ee',
)

# Filled from the same installed, fixed aiohttp version as production. A new
# private connector integration must fail closed when its native hooks drift.
_CONNECTOR_FUNCTION_HASHES = {
    '_create_connection': '1fc9f0b5725d8b8bea5dc935c9ac5af9a10483d77263ae77fd40c0c07ae77caf',
    'ClientRequest.send': '82b495aa06760c64fcd8bca3beea686967c0c4b338fcdf1ce3dc489d0e2d041f',
    'StreamWriter.write_headers': '41686943f544d978a2660c4549f0321216dffa78c79e438ec5e801ea602952a7',
    'connect': 'b9fe1f4d3e57ad12763a05c2f98a4d1d175420f418fe33d9de381ce94cf9eb6d',
    '_wrap_create_connection': '7d64ce08361620999ae00b8d363d5ad2548ca247a43d79e0ef186b2032b8433f',
    '_convert_hosts_to_addr_infos': 'e1ac6bbd92029d084fb2d3b90cced2d39f364f169fa036ea628e0d603a8fc2b2',
    '_get_ssl_context': '0f3a72a2828dc64435c7f967e8d0c5a527be6dfebbfc593f858d50a39826e74c',
}


class SmsNotDispatched(Exception):
    """This transport ended with no HTTP headers ever allowed to start."""

class SmsNotDispatchedPermanent(Exception):
    """Definitely unsent, but a configuration/unknown cause forbids retry."""


def _retryable_before_write(error):
    # Exact types and OS codes only. Certificate, contract and dependency
    # failures must never acquire permission to use another sending path.
    from aiohttp import ClientConnectorError, ClientConnectorDNSError, ConnectionTimeoutError
    if type(error) in (TimeoutError, ConnectionTimeoutError):
        return True
    if type(error) in (ClientConnectorError, ClientConnectorDNSError):
        error = error.os_error
    if type(error) is socket.gaierror:
        return error.errno == socket.EAI_AGAIN
    return (type(error) in (OSError, ConnectionRefusedError, ConnectionResetError,
                           ConnectionAbortedError, TimeoutError)
            and error.errno in {errno.ECONNREFUSED, errno.ECONNRESET,
                                errno.ECONNABORTED, errno.ETIMEDOUT,
                                errno.EHOSTUNREACH, errno.ENETUNREACH,
                                errno.ENETDOWN})


def _reject():
    # Never include an SDK request, URL, credential, header or exception text.
    raise ValueError('SMS_TRANSPORT_CONTRACT')

def _check_client(client):
    if (client._endpoint != HOST or client._protocol != 'HTTPS'
            or client._signature_version not in (None, '')
            or client._signature_algorithm not in (None, '', 'ACS3-HMAC-SHA256')
            or getattr(client._retry_options, 'retryable', None) is not False):
        _reject()

def bind_transport(client, deadline: float):
    """Keep official SDK signing/parsing, rebinding only this instance's IO.

    This internal compatibility bridge fails closed on dependency drift. It
    copies the function globals mapping, not the SDK signing implementation.
    """
    from alibabacloud_dypnsapi20170525.client import Client
    from alibabacloud_tea_openapi.client import Client as OpenApiClient
    from darabonba.core import DaraCore
    functions = (OpenApiClient.do_request_async, OpenApiClient.call_api_async,
                 Client.send_sms_verify_code_with_options_async)
    if (type(client) is not Client
            or any(name in client.__dict__ for name in
                   ('do_request_async', 'call_api_async', 'send_sms_verify_code_with_options_async'))
            or client.do_request_async.__func__ is not functions[0]
            or client.call_api_async.__func__ is not functions[1]
            or any(version(name) != expected for name, expected in PINNED.items())):
        _reject()
    for function, expected in zip(functions, _SDK_FUNCTION_HASHES):
        source = inspect.getsource(function).replace('\r\n', '\n').encode()
        if (function.__closure__ or function.__code__.co_freevars
                or hashlib.sha256(source).hexdigest() != expected):
            _reject()
    original = functions[0]
    if original.__globals__.get('DaraCore') is not DaraCore:
        _reject()
    _check_client(client)
    used = False
    transported = False
    class RestrictedCore(DaraCore):
        @staticmethod
        async def async_do_action(request, runtime_option=None):
            nonlocal transported
            _check_client(client)
            if transported:
                _reject()
            transported = True
            return await send_signed_request(request, runtime_option or {}, deadline)
    private_globals = dict(original.__globals__)
    private_globals['DaraCore'] = RestrictedCore
    restricted = FunctionType(original.__code__, private_globals, original.__name__,
                              original.__defaults__, original.__closure__)
    restricted.__kwdefaults__ = original.__kwdefaults__
    client.do_request_async = MethodType(restricted, client)
    async def guarded_call(self, params, request, runtime):
        nonlocal used
        _check_client(self)
        if (used or params.action != 'SendSmsVerifyCode' or params.method != 'POST'
                or params.version != '2017-05-25' or params.pathname != '/'
                or params.protocol != 'HTTPS' or params.auth_type != 'AK'
                or params.style != 'RPC' or params.body_type != 'json'):
            _reject()
        used = True
        return await functions[1](self, params, request, runtime)
    client.call_api_async = MethodType(guarded_call, client)
    return client

def _tls_context():
    import certifi
    context = ssl.create_default_context(cafile=certifi.where())
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    return context

async def _resolve_addresses(state=None):
    from aiohttp.resolver import ThreadedResolver
    resolver = ThreadedResolver()
    try:
        records = await resolver.resolve(HOST, 443, family=socket.AF_UNSPEC)
    finally:
        await resolver.close()
    # No hardcoded provider IP: choose at most two current DNS addresses.
    result, seen = [], set()
    for record in records:
        key = (record['host'], record['family'])
        if key not in seen:
            seen.add(key)
            result.append(record)
    if not result:
        raise OSError('SMS_DNS_EMPTY')
    if len(result) > 1:
        other = next((row for row in result[1:] if row['family'] != result[0]['family']), result[1])
        selected = [result[0], other]
    else:
        selected = result
    _record_dns_snapshot(state, records, result, selected)
    return selected

def _validate_request(request, runtime):
    if (request.protocol != 'HTTPS' or request.method != 'POST'
            or request.pathname != '/' or request.port not in (80, 443)
            or request.headers.get('host') != HOST
            or request.headers.get('x-acs-action') != 'SendSmsVerifyCode'
            or request.headers.get('x-acs-version') != '2017-05-25'
            or request.body not in (None, b'', '')
            or request.query.get('AutoRetry') != '0'
            or runtime.get('ignoreSSL')
            or any(runtime.get(name) for name in
                   ('httpProxy', 'httpsProxy', 'socks5Proxy', 'key', 'cert', 'ca'))):
        _reject()

def _diagnostic(code, state):
    allowed = {'connection_retry', 'response_received', 'cancelled_before_write',
               'cancelled_after_write', 'timeout_before_write', 'timeout_after_write',
               'failed_before_write', 'failed_after_write'}
    if code not in allowed:
        return
    try:
        _LOGGER.info(json.dumps({'event': 'sms_transport', 'code': code,
            'connection_attempts': state['attempts'],
            'write_may_have_started': state['written']}, separators=(',', ':')))
    except Exception:
        pass


class _ConnectionPhase:
    """Per-contender observations; no request/endpoint/exception text retained."""
    def __init__(self, state, attempt):
        self.state, self.attempt = state, attempt
        self.clock = asyncio.get_running_loop().time
        state.setdefault('_phase_origin', self.clock())
        state.setdefault('_phase_records', [])
        self.stage, self.started = None, None

    def _record(self, status, reason='none'):
        # Recording must never replace the transport's result or exception.
        try:
            now = self.clock()
            records = self.state['_phase_records']
            if (self.attempt not in (0, 1, 2) or self.stage not in ('dns', 'tcp', 'tls')
                    or status not in ('started', 'completed', 'stopped')
                    or reason not in ('none', 'timeout', 'cancelled', 'certificate_error',
                                      'tls_error', 'connection_error', 'other_error')
                    or len(records) >= 10):
                return
            records.append({'attempt': self.attempt, 'stage': self.stage,
                'status': status, 'reason': reason,
                'offset_ms': min(60000, max(0, int((now-self.state['_phase_origin'])*1000))),
                'elapsed_ms': min(60000, max(0, int((now-self.started)*1000)))})
        except Exception:
            pass

    def start(self, stage):
        self.stage, self.started = stage, self.clock()
        self._record('started')

    def complete(self):
        self._record('completed')
        self.stage, self.started = None, None

    def stop(self, error):
        import aiohttp
        if self.stage is None:
            return
        if isinstance(error, asyncio.CancelledError): reason = 'cancelled'
        elif isinstance(error, TimeoutError): reason = 'timeout'
        elif isinstance(error, (ssl.SSLCertVerificationError, aiohttp.ClientConnectorCertificateError)):
            reason = 'certificate_error'
        elif isinstance(error, (ssl.SSLError, aiohttp.ClientConnectorSSLError)): reason = 'tls_error'
        elif isinstance(error, (OSError, aiohttp.ClientConnectorError)): reason = 'connection_error'
        else: reason = 'other_error'
        self._record('stopped', reason)
        self.stage, self.started = None, None


def _diagnostic_phases(state):
    # One bounded aggregate after the original outcome. Never serialize state,
    # requests, sockets, connection keys, exception objects, or their messages.
    try:
        records = state.get('_phase_records', [])
        if records:
            _LOGGER.info(json.dumps({'event': 'sms_transport_phases',
                'phases': records[:10]}, separators=(',', ':')))
    except Exception:
        pass



def _bounded_ms(seconds):
    return min(60000, max(0, int(seconds * 1000)))


def _record_dns_snapshot(state, records, unique, selected):
    # Diagnostic-only projection. Resolver records and ordering are untouched.
    try:
        if state is None or len(records) > 1024 or any(
                row['family'] not in (socket.AF_INET, socket.AF_INET6) for row in unique):
            return
        rows = []
        for attempt, row in enumerate(selected, 1):
            family = 'ipv4' if row['family'] == socket.AF_INET else 'ipv6' if row['family'] == socket.AF_INET6 else 'other'
            index = next(i for i, original in enumerate(records, 1)
                         if (original['host'], original['family']) == (row['host'], row['family']))
            fingerprint = hashlib.sha256(json.dumps(
                [family, row['host'], row['port']], ensure_ascii=True,
                separators=(',', ':')).encode('utf-8')).hexdigest()
            rows.append({'attempt': attempt, 'address_index': index,
                         'family': family, 'address_sha256': fingerprint})
        state['_dns_snapshot'] = {'unique_count': len(unique),
            'ipv4_count': sum(row['family'] == socket.AF_INET for row in unique),
            'ipv6_count': sum(row['family'] == socket.AF_INET6 for row in unique),
            'selected': rows}
    except Exception:
        pass


class _RequestObservation:
    """Bounded call_at handles only; no background task or socket ownership."""
    def __init__(self, loop):
        self.loop, self.origin = loop, loop.time()
        self.handle = None
        self.stopped = False
        self.started = self.available = False
        self.samples = self.max_delay = self.tail_delay = 0
        self.next_due = self.origin + .02
        self.tcp_samples = []
        self.tcp_info_supported = sys.platform == 'linux' and hasattr(socket, 'TCP_INFO')

    def start(self):
        try:
            self.handle = self.loop.call_at(self.next_due, self.tick)
            self.started = self.available = True
        except Exception:
            self.available = False
            self.stopped = True

    def tick(self):
        try:
            if self.stopped or self.samples >= 250:
                return
            now = self.loop.time()
            self.samples += 1
            self.max_delay = max(self.max_delay, _bounded_ms(now - self.next_due))
            self.next_due = now + .02
            if self.samples < 250:
                self.handle = self.loop.call_at(self.next_due, self.tick)
        except Exception:
            self.available = False
            self.stop()

    def stop(self):
        was_active = not self.stopped
        self.stopped = True
        handle, self.handle = self.handle, None
        try:
            if was_active:
                self.tail_delay = _bounded_ms(self.loop.time() - self.next_due)
                self.max_delay = max(self.max_delay, self.tail_delay)
        except Exception:
            self.available = False
        finally:
            try:
                if handle is not None:
                    handle.cancel()
            except Exception:
                pass


def _start_request_observation(state):
    try:
        observer = _RequestObservation(asyncio.get_running_loop())
        state['_request_observation'] = observer
        observer.start()
    except Exception:
        pass


def _stop_request_observation(state):
    try:
        observer = state.get('_request_observation')
        if observer is not None:
            observer.stop()
    except Exception:
        pass


def _diagnostic_context(state):
    try:
        observer = state.get('_request_observation')
        if observer is None:
            return
        availability = 'unavailable' if not observer.available else 'available' if observer.samples else 'no_samples'
        # stop() measures the unfinished timer even if its first callback
        # never ran. Preserve that tail gap; zero callbacks is not no delay.
        measured = observer.available and observer.started and observer.stopped
        _LOGGER.info(json.dumps({'event': 'sms_transport_context',
            'dns': state.get('_dns_snapshot'),
            'heartbeat': {'scope': 'dns_through_transport', 'started': observer.started,
                          'availability': availability, 'interval_ms': 20, 'sample_count': observer.samples,
                          'max_delay_ms': observer.max_delay if measured else None,
                          'tail_delay_ms': observer.tail_delay if measured else None},
            'tcp_info_supported': observer.tcp_info_supported,
            'tcp_samples': observer.tcp_samples[:10]}, separators=(',', ':')))
    except Exception:
        pass


class _SocketObservation:
    def __init__(self, request, attempt):
        self.request, self.attempt = request, attempt
        self.sock = None
        self.handles = []
        self.started = None
        self.stopped = False

    def create_socket(self, addr_info):
        # Exactly aiohappyeyeballs' default constructor. Creation failure must
        # propagate unchanged; the native library still owns all socket IO.
        family, type_, proto, _, _ = addr_info
        sock = socket.socket(family=family, type=type_, proto=proto)
        try:
            self.sock, self.started = sock, self.request.loop.time()
            for offset in (.1, .5, 1.5, 2.4):
                self.handles.append(self.request.loop.call_at(
                    self.started + offset, self.sample, 'timer', int(offset * 1000)))
        except Exception:
            self.stop()
        return sock

    def sample(self, trigger, scheduled_ms):
        try:
            if self.stopped or self.sock is None or len(self.request.tcp_samples) >= 10:
                return
            now = self.request.loop.time()
            status = 'UNAVAILABLE'
            if self.request.tcp_info_supported:
                try:
                    info = self.sock.getsockopt(socket.IPPROTO_TCP, socket.TCP_INFO, 1)
                    if isinstance(info, bytes) and len(info) == 1:
                        status = 'ESTABLISHED' if info[0] == 1 else 'SYN_SENT' if info[0] == 2 else 'OTHER'
                except Exception:
                    pass
            self.request.tcp_samples.append({'attempt': self.attempt,
                'trigger': trigger, 'scheduled_ms': scheduled_ms, 'state': status,
                'offset_ms': _bounded_ms(now - self.request.origin),
                'elapsed_ms': _bounded_ms(now - self.started)})
        except Exception:
            pass

    def completed(self):
        try:
            self.sample('tcp_completed', 0)
        finally:
            self.stop()

    def stop(self):
        self.stopped = True
        self.sock = None
        for handle in self.handles:
            try:
                handle.cancel()
            except Exception:
                pass
        self.handles.clear()


def _socket_observation(state, attempt):
    try:
        request = state.get('_request_observation')
        return _SocketObservation(request, attempt) if request is not None else None
    except Exception:
        return None


def _socket_observation_end(observer, completed=False):
    try:
        if observer is not None:
            observer.completed() if completed else observer.stop()
    except Exception:
        pass


async def send_signed_request(request, runtime, deadline):
    state = {'attempts': 0, 'written': False}
    try:
        try:
            result = await _send_signed_request(request, runtime, deadline, state)
        except asyncio.CancelledError:
            _diagnostic('cancelled_after_write' if state['written'] else 'cancelled_before_write', state)
            raise
        except TimeoutError as error:
            _diagnostic('timeout_after_write' if state['written'] else 'timeout_before_write', state)
            if not state['written']:
                kind = SmsNotDispatched if _retryable_before_write(error) else SmsNotDispatchedPermanent
                raise kind() from error
            raise
        except Exception as error:
            _diagnostic('failed_after_write' if state['written'] else 'failed_before_write', state)
            if not state['written']:
                kind = SmsNotDispatched if _retryable_before_write(error) else SmsNotDispatchedPermanent
                raise kind() from error
            raise
        _diagnostic('response_received', state)
        return result
    finally:
        _stop_request_observation(state)
        _diagnostic_phases(state)
        _diagnostic_context(state)



def _check_connector_runtime():
    import aiohttp
    from aiohttp.http_writer import StreamWriter
    functions = {
        '_create_connection': aiohttp.TCPConnector._create_connection,
        'ClientRequest.send': aiohttp.ClientRequest.send,
        'StreamWriter.write_headers': StreamWriter.write_headers,
        'connect': aiohttp.BaseConnector.connect,
        '_wrap_create_connection': aiohttp.TCPConnector._wrap_create_connection,
        '_convert_hosts_to_addr_infos': aiohttp.TCPConnector._convert_hosts_to_addr_infos,
        '_get_ssl_context': aiohttp.TCPConnector._get_ssl_context,
    }
    if (any(version(name) != PINNED[name] for name in ('aiohttp', 'aiohappyeyeballs'))
            or set(functions) != set(_CONNECTOR_FUNCTION_HASHES)):
        _reject()
    for name, function in functions.items():
        source = inspect.getsource(function).replace('\r\n', '\n').encode()
        if hashlib.sha256(source).hexdigest() != _CONNECTOR_FUNCTION_HASHES[name]:
            _reject()


async def _race_tls_connections(connect, count, deadline, state):
    """Race only completed TLS transports; no contender can send HTTP.

    Cancellation drains every contender, including a second success racing with
    cancellation. Every non-winning transport is aborted before returning.
    """
    import aiohttp
    if count not in (1, 2):
        _reject()
    loop = asyncio.get_running_loop()
    tasks, winner = [], None
    last_error = None

    async def attempt(index):
        if loop.time() >= deadline:
            raise TimeoutError()
        state['attempts'] += 1
        return await connect(index)

    def start(index):
        task = asyncio.create_task(attempt(index))
        tasks.append(task)
        return task

    def finish(done):
        nonlocal last_error
        successful = []
        for task in tasks:
            if task not in done:
                continue
            error = task.exception()
            if error is None:
                successful.append(task.result())
            else:
                # TLS/certificate/DNS/proxy/contract errors remain fatal. Only
                # a plain connection failure/timeout permits the other address.
                if type(error) not in (aiohttp.ClientConnectorError,
                                       aiohttp.ConnectionTimeoutError, TimeoutError):
                    raise error
                last_error = error
        return successful[0] if successful else None

    try:
        pending = {start(0)}
        done, pending = await asyncio.wait(
            pending, timeout=min(CONNECTION_STAGGER_SECONDS, max(0, deadline-loop.time())),
            return_when=asyncio.FIRST_COMPLETED)
        winner = finish(done)
        if winner is None and count == 2:
            if loop.time() >= deadline:
                raise TimeoutError()
            _diagnostic('connection_retry', state)
            pending.add(start(1))
        while winner is None and pending:
            done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            winner = finish(done)
        if winner is None:
            raise last_error if last_error is not None else TimeoutError()
        if loop.time() >= deadline:
            raise TimeoutError()
    except BaseException:
        winner = None
        raise
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        # Native asyncio/aiohttp connection establishment honours cancellation.
        # Even a contender returning during cancellation is closed below.
        def close_result(task):
            if not task.cancelled() and task.exception() is None:
                task.result()[0].abort()
        try:
            results = await asyncio.gather(*tasks, return_exceptions=True)
        except BaseException:
            for task in tasks:
                task.add_done_callback(close_result)
            raise
        for result in results:
            if isinstance(result, tuple) and result is not winner:
                result[0].abort()
    return winner


def _tls_race_connector(addresses, context, deadline, state):
    import aiohttp
    _check_connector_runtime()
    if not 1 <= len(addresses) <= 2 or not context.check_hostname or context.verify_mode != ssl.CERT_REQUIRED:
        _reject()

    class TlsRaceConnector(aiohttp.TCPConnector):
        async def _wrap_create_connection(
            self, *args, addr_infos, req, timeout,
            client_error=aiohttp.ClientConnectorError, _diagnostic_attempt, **kwargs,
        ):
            # The native method below is checked by the original hash gate above.
            # Its timeout/arguments/socket ownership/exception semantics are kept.
            from aiohttp.connector import (aiohappyeyeballs, ceil_timeout, cert_errors,
                ssl_errors, ClientConnectorCertificateError, ClientConnectorSSLError, sys)
            phase = _ConnectionPhase(state, _diagnostic_attempt)
            observer = _socket_observation(state, _diagnostic_attempt)
            try:
                try:
                    async with ceil_timeout(
                        timeout.sock_connect, ceil_threshold=timeout.ceil_threshold
                    ):
                        phase.start('tcp')
                        sock = await aiohappyeyeballs.start_connection(
                            addr_infos=addr_infos,
                            local_addr_infos=self._local_addr_infos,
                            happy_eyeballs_delay=self._happy_eyeballs_delay,
                            interleave=self._interleave,
                            loop=self._loop,
                            socket_factory=observer.create_socket if observer is not None else self._socket_factory,
                        )
                        _socket_observation_end(observer, completed=True)
                        phase.complete()
                        # Add ssl_shutdown_timeout for Python 3.11+ when SSL is used
                        if (
                            kwargs.get("ssl")
                            and self._ssl_shutdown_timeout
                            and sys.version_info >= (3, 11)
                        ):
                            kwargs["ssl_shutdown_timeout"] = self._ssl_shutdown_timeout
                        phase.start('tls')
                        result = await self._loop.create_connection(*args, **kwargs, sock=sock)
                        phase.complete()
                        return result
                except cert_errors as exc:
                    raise ClientConnectorCertificateError(req.connection_key, exc) from exc
                except ssl_errors as exc:
                    raise ClientConnectorSSLError(req.connection_key, exc) from exc
                except OSError as exc:
                    if exc.errno is None and isinstance(exc, asyncio.TimeoutError):
                        raise
                    raise client_error(req.connection_key, exc) from exc
            except BaseException as error:
                # This is outside native ceil_timeout, so its converted timeout
                # remains timeout; winner/caller/deadline cancellation stays unknown.
                phase.stop(error)
                raise
            finally:
                _socket_observation_end(observer)

        async def _create_direct_connection(self, req, traces, timeout, *,
                                            client_error=aiohttp.ClientConnectorError):
            if (req.url.raw_host != HOST or req.port != 443 or not req.is_ssl()
                    or req.proxy is not None or req.server_hostname != HOST
                    or self._get_ssl_context(req) is not context):
                _reject()
            infos = self._convert_hosts_to_addr_infos(addresses)
            if len(infos) != len(addresses):
                _reject()

            async def connect(index):
                # Native _wrap_create_connection returns only after TCP AND
                # certificate-verified TLS. Each invocation has one address.
                return await self._wrap_create_connection(
                    self._factory, timeout=timeout, ssl=context,
                    addr_infos=[infos[index]], server_hostname=HOST,
                    req=req, client_error=client_error, _diagnostic_attempt=index+1)

            return await _race_tls_connections(connect, len(infos), deadline, state)

    return TlsRaceConnector(use_dns_cache=False, family=socket.AF_UNSPEC,
                            ssl=context, force_close=True, limit=1,
                            happy_eyeballs_delay=None)


async def _send_signed_request(request, runtime, deadline, state):
    """At most two TLS contenders; exactly one possible HTTP write path."""
    import aiohttp
    from darabonba.core import DaraCore
    from darabonba.response import DaraResponse
    _validate_request(request, runtime)
    loop = asyncio.get_running_loop()
    if loop.time() >= deadline:
        raise TimeoutError()
    # SDK URL/signature stays unchanged and private in memory.
    url = DaraCore.compose_url(request)
    context = _tls_context()
    async def before_headers(*_):
        # aiohttp calls this before header serialization/buffering, including
        # empty-body POSTs. This flag is sticky across both connections.
        state['written'] = True
        if loop.time() >= deadline:
            raise TimeoutError()
    async with asyncio.timeout_at(deadline) as timer:
        _start_request_observation(state)
        dns = _ConnectionPhase(state, 0)
        dns.start('dns')
        try:
            addresses = await _resolve_addresses(state)
        except BaseException as error:
            dns.stop(error)
            raise
        dns.complete()
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise TimeoutError()
        trace = aiohttp.TraceConfig()
        trace.on_request_headers_sent.append(before_headers)
        connector = _tls_race_connector(addresses, context, deadline, state)
        # Both connections run within 2.75 seconds instead of two sequential
        # 1.5-second waits. Each can now complete a slow, valid TLS handshake;
        # a full 3.5-second send budget leaves at least 0.75s for the response.
        # A shorter caller deadline always takes precedence over these caps.
        connection_window = CONNECTION_ATTEMPT_SECONDS + (CONNECTION_STAGGER_SECONDS if len(addresses) == 2 else 0)
        timeout = aiohttp.ClientTimeout(total=remaining, connect=min(connection_window, remaining),
                                        sock_connect=min(CONNECTION_ATTEMPT_SECONDS, remaining), sock_read=remaining)
        async with aiohttp.ClientSession(
            connector=connector, trust_env=False,
            cookie_jar=aiohttp.DummyCookieJar(), trace_configs=[trace],
        ) as session:
            async with session.request(
                'POST', url, data=b'', headers=request.headers,
                ssl=context, server_hostname=HOST, proxy=None,
                allow_redirects=False, timeout=timeout,
            ) as response:
                state['written'] = True
                if 300 <= response.status < 400:
                    _reject()
                body = bytearray()
                async for chunk in response.content.iter_chunked(16384):
                    body.extend(chunk)
                    if len(body) > MAX_RESPONSE_BYTES:
                        _reject()
                result = DaraResponse()
                result.body = bytes(body)
                result.headers = {k.lower(): v for k, v in response.headers.items()}
                result.status_code = response.status
                result.status_message = response.reason
        if timer.expired() or loop.time() >= deadline:
            raise TimeoutError()
        return result
    raise TimeoutError()
