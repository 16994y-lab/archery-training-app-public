"""Fixed private ZIP/restored objects; no list, overwrite, delete, signing or retry.

Evidence is independently supplied by Root, never produced by this adapter.
A durable object store is not represented as a filesystem volume.
"""
from dataclasses import dataclass, replace
from contextlib import contextmanager
import hashlib
import hmac
import json
import math
import re
import time
from urllib.error import HTTPError
from urllib.request import Request

from fastapi import HTTPException
from .supabase_private_media_store import (APPROVED_ORIGIN, MAX_OBJECT_BYTES,
    MEDIA_MIME_TYPES, SupabasePrivateMediaStore, build_opener, ProxyHandler, HTTPSHandler,
    _verified_tls_context, _RejectRedirects)

ARCHIVE_MIME = "application/zip"
ARCHIVE_CHUNK_BYTES = 3 * 1024 * 1024

@dataclass(frozen=True, repr=False)
class RuntimeObjectArchiveAttestation:
    operation_id: str = ""
    source_sha256: str = ""
    receipt_id: str = ""
    origin: str = ""
    bucket: str = ""
    namespace: str = "archives-v1"
    key_sha256: str = ""
    verified_at: float | None = None
    expires_at: float | None = None
    bucket_private: bool = False
    credential_verified: bool = False
    archive_read_allowed: bool = False
    archive_insert_allowed: bool = False
    restore_read_allowed: bool = False
    restore_insert_allowed: bool = False
    allowed_mime_types: frozenset[str] = frozenset()
    max_file_bytes: int = 0
    durability_verified: bool = False
    durability_receipt_id: str = ""
    copy_bucket: str | None = None
    copy_bucket_private: bool = False
    copy_read_allowed: bool = False
    copy_insert_allowed: bool = False
    copy_max_file_bytes: int | None = None
    independent_copy_verified: bool = False
    independent_copy_receipt_id: str | None = None
    retention_policy_id: str | None = None
    retention_policy_verified: bool = False
    retention_receipt_id: str | None = None


def object_archive_facts_valid(p, now):
    def ident(x): return type(x) is str and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", x) is not None
    def sha(x): return type(x) is str and re.fullmatch(r"[a-f0-9]{64}", x) is not None
    def bucket(x): return type(x) is str and re.fullmatch(r"[a-z0-9][a-z0-9_-]{2,62}", x) is not None
    def num(x): return type(x) in (int,float) and math.isfinite(x)
    try:
        if (type(p) is not RuntimeObjectArchiveAttestation or not ident(p.operation_id)
            or not sha(p.source_sha256) or not ident(p.receipt_id) or p.origin != APPROVED_ORIGIN
            or not bucket(p.bucket) or p.namespace != "archives-v1" or not sha(p.key_sha256)
            or not num(now) or not num(p.verified_at) or not num(p.expires_at)
            or not p.verified_at <= now < p.expires_at <= p.verified_at + 86400
            or any(v is not True for v in (p.bucket_private,p.credential_verified,p.archive_read_allowed,
                p.archive_insert_allowed,p.restore_read_allowed,p.restore_insert_allowed,p.durability_verified))
            or type(p.allowed_mime_types) is not frozenset
            or p.allowed_mime_types != MEDIA_MIME_TYPES | {ARCHIVE_MIME}
            or type(p.max_file_bytes) is not int or not MAX_OBJECT_BYTES <= p.max_file_bytes <= 2**63-1
            or not ident(p.durability_receipt_id)):
            return False
        if p.independent_copy_verified is True:
            if (not bucket(p.copy_bucket) or p.copy_bucket == p.bucket
                or any(v is not True for v in (p.copy_bucket_private,p.copy_read_allowed,p.copy_insert_allowed))
                or type(p.copy_max_file_bytes) is not int or p.copy_max_file_bytes < MAX_OBJECT_BYTES
                or not ident(p.independent_copy_receipt_id)):
                return False
        elif (p.independent_copy_verified is not False or p.copy_bucket is not None
            or p.copy_bucket_private is not False or p.copy_read_allowed is not False
            or p.copy_insert_allowed is not False or p.copy_max_file_bytes is not None
            or p.independent_copy_receipt_id is not None):
            return False
        if p.retention_policy_verified is True:
            if not ident(p.retention_policy_id) or not ident(p.retention_receipt_id):return False
        elif p.retention_policy_verified is not False or p.retention_policy_id is not None or p.retention_receipt_id is not None:
            return False
        return True
    except (TypeError,ValueError,AttributeError,OverflowError):
        return False


class SupabaseArchiveObjectStore(SupabasePrivateMediaStore):
    mode = "supabase-private-archive-object-candidate"
    def __init__(self, evidence=None, server_key=None, *, admission=None, transport=None,
                 clock=time.time, monotonic=time.monotonic, timeout_seconds=30):
        # Default closed construction does not read clocks, environment or key.
        self._archive_evidence,self._admission = evidence,admission
        self._clock,self._monotonic = clock,monotonic
        self._transport=transport
        self._configured=False
        if evidence is None:return
        if type(evidence) is not RuntimeObjectArchiveAttestation:
            raise ValueError("Archive requires typed independent object evidence")
        super().__init__(evidence.origin,evidence.bucket,server_key,transport=transport,
                         clock=clock,monotonic=monotonic,timeout_seconds=timeout_seconds)
        self._configured=True
        if hashlib.sha256(server_key.encode()).hexdigest()!=evidence.key_sha256:
            raise ValueError("Archive key binding differs")

    @property
    def protection_verified(self):
        if not self._configured:return False
        try:
            if self._admission is not None:self._admission()
            return bool(object_archive_facts_valid(self._archive_evidence,self._clock())
                and (self._legacy_expiry is None or self._legacy_expiry > self._clock()+60))
        except Exception:return False

    def _open(self,request):
        deadline=self._monotonic()+self._timeout
        if self._transport is not None:
            self._deadline(deadline)
            return self._transport(request,timeout=self._timeout)
        if self._opener is None:
            self._opener=build_opener(ProxyHandler({}),HTTPSHandler(context=_verified_tls_context()),_RejectRedirects())
        # TLS/opener setup may block: no new request after withdrawal or expiry.
        self._deadline(deadline)
        return self._opener.open(request,timeout=deadline-self._monotonic())

    @contextmanager
    def _response(self,*args,**kwargs):
        deadline=self._monotonic()+self._timeout
        with super()._response(*args,**kwargs) as packet:yield packet
        self._deadline(deadline)  # Includes response.close(); late bytes are not returned.

    @property
    def binding_id(self):
        p=self._archive_evidence
        if p is None:return None
        raw=json.dumps([p.origin,p.bucket,p.namespace,p.copy_bucket],separators=(",",":"))
        return hashlib.sha256(raw.encode()).hexdigest()

    @staticmethod
    def _id(x):
        if type(x) is not str or re.fullmatch(r"[a-f0-9]{32}",x) is None:
            raise HTTPException(404,"Archive object unavailable")
        return x

    def _base(self,owner):
        if type(owner) is not str or not 1 <= len(owner) <= 128:
            raise HTTPException(404,"Archive owner unavailable")
        return "archives-v1/"+hashlib.sha256(owner.encode()).hexdigest()

    def _archive_path(self,owner,identity):return self._base(owner)+"/zips/"+self._id(identity)+".zip"
    def _restore_path(self,owner,restore_id,object_id):
        return self._base(owner)+"/restored/"+self._id(restore_id)+"/"+self._id(object_id)

    def _read_fixed(self,path,size,mime):
        expected=self._size(size)
        with self._response("GET",path) as (r,d):
            if r.status!=200:raise HTTPException(503,"Original archive object read unknown; no replay")
            if (self._header(r,"Content-Type") or "").split(";",1)[0].strip().lower()!=mime:
                raise HTTPException(409,"Archive object MIME differs; retained")
            value=self._bounded(r,expected,d,exact=expected)
            self._deadline(d)
            return value

    def _put_fixed(self,path,content,mime):
        self._require_protection()
        if type(content) is not bytes:raise HTTPException(422,"Archive immutable bytes required")
        self._size(len(content))
        with self._response("POST",path,content=content,mime=mime) as (r,d):
            if r.status in (200,201):
                ack=self._json(r,d)
                if ack.get("Key")!=f"{self.bucket}/{path}" or type(ack.get("Id")) is not str or re.fullmatch(r"[a-fA-F0-9-]{32,36}",ack["Id"]) is None:
                    raise HTTPException(503,"Archive write acknowledgement unknown; no replay")
            elif r.status in (400,409):
                ack=self._json(r,d)
                tags={ack[k] for k in ("code","error") if type(ack.get(k)) is str}
                if not tags or not tags <= {"Duplicate","ResourceAlreadyExists"}:
                    raise HTTPException(409,"Archive duplicate unknown; no overwrite")
            else:raise HTTPException(503,"Archive write unknown; no retry")
        # Read fixed original only. Unknown POST never loops or performs another POST.
        saved=self._read_fixed(path,len(content),mime)
        if not hmac.compare_digest(hashlib.sha256(saved).digest(),hashlib.sha256(content).digest()):
            raise HTTPException(409,"Archive existing bytes differ; no overwrite")

    def read_archive(self,owner,identity,size):return self._read_fixed(self._archive_path(owner,identity),size,ARCHIVE_MIME)
    def put_archive(self,owner,identity,content):return self._put_fixed(self._archive_path(owner,identity),content,ARCHIVE_MIME)
    def read_restored(self,owner,restore_id,object_id,size,mime):
        if mime not in MEDIA_MIME_TYPES:raise HTTPException(422,"Restore MIME unavailable")
        return self._read_fixed(self._restore_path(owner,restore_id,object_id),size,mime)
    def put_restored(self,owner,restore_id,object_id,content,mime):
        if mime not in MEDIA_MIME_TYPES:raise HTTPException(422,"Restore MIME unavailable")
        return self._put_fixed(self._restore_path(owner,restore_id,object_id),content,mime)

    def _copy_store(self):
        self._require_protection()
        p=self._archive_evidence
        if not p.independent_copy_verified:raise HTTPException(503,"Independent ZIP copy unknown")
        copy=replace(p,bucket=p.copy_bucket,max_file_bytes=p.copy_max_file_bytes,copy_bucket=None,
            copy_bucket_private=False,copy_read_allowed=False,copy_insert_allowed=False,copy_max_file_bytes=None,
            independent_copy_verified=False,independent_copy_receipt_id=None)
        return SupabaseArchiveObjectStore(copy,self._key,admission=self._admission,transport=self._transport,
            clock=self._clock,monotonic=self._monotonic,timeout_seconds=self._timeout)
    def read_copy(self,owner,identity,size):return self._copy_store().read_archive(owner,identity,size)
    def put_copy(self,owner,identity,content):return self._copy_store().put_archive(owner,identity,content)

    def read_archive_range(self,owner,identity,total,offset,length):
        self._require_protection();self._size(total)
        if (type(offset) is not int or type(length) is not int or offset<0
            or not 1<=length<=ARCHIVE_CHUNK_BYTES or offset+length>total):
            raise HTTPException(422,"Fixed ZIP chunk bounds invalid")
        path=self._archive_path(owner,identity)
        url=f"{self.origin}/storage/v1/object/authenticated/{self.bucket}/{path}"
        headers=self._headers();headers["Range"]=f"bytes={offset}-{offset+length-1}"
        request=Request(url,headers=headers,method="GET")
        deadline=self._monotonic()+self._timeout;r=None;accepted=False
        try:
            self._deadline(deadline)
            try:r=self._open(request)
            except HTTPError as error:r=error
            except Exception:raise HTTPException(503,"Archive range result unknown") from None
            self._deadline(deadline)
            if r.geturl()!=url or r.status!=206:raise HTTPException(503,"Exact ZIP range not confirmed")
            if (self._header(r,"Content-Range")!=f"bytes {offset}-{offset+length-1}/{total}"
                or self._header(r,"Content-Encoding") not in (None,"identity")
                or (self._header(r,"Content-Type") or "").split(";",1)[0].strip().lower()!=ARCHIVE_MIME):
                raise HTTPException(409,"Archive partial response binding differs")
            value=self._bounded(r,length,deadline,exact=length)
            self._deadline(deadline);accepted=True;return value
        except HTTPException:raise
        except Exception:raise HTTPException(503,"Archive range could not be confirmed") from None
        finally:
            if r is not None:
                try:r.close()
                except Exception:pass
            if accepted:self._deadline(deadline)
