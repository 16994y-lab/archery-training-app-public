"""Contribution-only immutable storage. No change to personal media capabilities."""
from dataclasses import dataclass
from pathlib import Path
import hashlib,json,os,re,time
from urllib.error import HTTPError
from urllib.request import Request
from fastapi import HTTPException
from app.private_media import LocalPrivateMediaStore
from app.supabase_private_media_store import SupabasePrivateMediaStore

PREFIX='contributions/v1'
MAX_IMAGE=8*1024*1024

class ContributionDeleteNotDispatched(Exception):
    """Private fixed signal: the DELETE transport entry was never called."""
def _object_missing(status,value):
    # Storage renders its historical HTTP 400 with a logical 404 as a string.
    # Only these two exact combinations mean absence; every other error stays unknown.
    if type(value) is not dict or value.get('code')!='NoSuchKey':return False
    logical=value.get('statusCode')
    return status==404 or (status==400 and
        ((type(logical) is int and logical==404) or (type(logical) is str and logical=='404')))

def safe_error():
    return HTTPException(503,'贡献存储结果尚未核实；保留原请求，只读核对')
def object_path(object_id):
    if not isinstance(object_id,str) or not re.fullmatch(r'[a-f0-9]{32}',object_id):raise safe_error()
    return f'{PREFIX}/{object_id[:2]}/{object_id}.png'
@dataclass(frozen=True)
class StoredContribution:
    content:bytes
    version:str

class LocalContributionStore:
    purpose='photo-contribution'
    deletion_supported=True
    def __init__(self,root,*,protection_verified=False):
        self.root=Path(root)
        if not self.root.is_absolute():raise safe_error()
        LocalPrivateMediaStore._check_tree(self.root)
        self.protection_verified=protection_verified
    def _path(self,object_id):
        if self.protection_verified is not True:raise safe_error()
        path=self.root/object_path(object_id)
        LocalPrivateMediaStore._check_tree(path)
        if not path.resolve().is_relative_to(self.root.resolve()):raise safe_error()
        return path
    def put(self,object_id,content):
        path=self._path(object_id)
        if not isinstance(content,bytes) or not 1<=len(content)<=MAX_IMAGE:raise safe_error()
        path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        LocalPrivateMediaStore._check_tree(path)
        try:
            with path.open('xb') as stream:
                os.chmod(path,0o600);stream.write(content);stream.flush();os.fsync(stream.fileno())
        except Exception:raise safe_error() from None
    def inspect(self,object_id,expected_size,version=None):
        path=self._path(object_id)
        try:
            if path.stat().st_size!=expected_size:raise safe_error()
            with path.open('rb') as stream:content=stream.read(expected_size+1)
        except FileNotFoundError:return None
        except Exception:raise safe_error() from None
        if len(content)!=expected_size:raise safe_error()
        actual=hashlib.sha256(content).hexdigest()
        if version is not None and version!=actual:raise safe_error()
        return StoredContribution(content,actual)
    def read(self,object_id,expected_size):
        found=self.inspect(object_id,expected_size)
        if found is None:raise safe_error()
        return found.content
    def remove(self,object_id,expected_size,version):
        found=self.inspect(object_id,expected_size,version)
        if found is None:raise safe_error()
        try:self._path(object_id).unlink() # One validated contribution object only.
        except Exception:raise safe_error() from None

class _ContributionWire(SupabasePrivateMediaStore):
    """Dedicated instance guard; personal-media class and instances are unchanged."""
    def __init__(self,*args,live_guard=None,**kwargs):
        self._contribution_guard=live_guard
        super().__init__(*args,**kwargs)
    @property
    def protection_verified(self):
        if self._contribution_guard is None:return super().protection_verified
        try:return self._contribution_guard() is True and (self._legacy_expiry is None or self._legacy_expiry>self._clock()+60)
        except Exception:return False

class SupabaseContributionStore:
    """Exact version deletion + fixed prefix; server key stays in the original process.

    Composition reuses TLS/auth/evidence/response bounds, NOT the personal store's
    object API or DELETE whitelist. Construction never contacts the provider.
    """
    purpose='photo-contribution'
    deletion_supported=True
    def __init__(self,origin,bucket,server_key,*,protection=None,transport=None,clock=time.time,timeout_seconds=15,live_guard=None):
        if live_guard is not None and not callable(live_guard):raise safe_error()
        self._live_guard=live_guard
        self._wire=_ContributionWire(origin,bucket,server_key,protection=protection,transport=transport,clock=clock,timeout_seconds=timeout_seconds,live_guard=live_guard)
        self.origin,self.bucket=origin,bucket
    @property
    def protection_verified(self):
        return self._wire.protection_verified
    def _request(self,method,route,body=None,mime=None,maximum=65536):
        wire=self._wire;response=None;dispatched=False
        try:
            if not self.protection_verified:raise safe_error()
            url=f'{self.origin}/storage/v1/{route}'
            headers=wire._headers();headers['Cache-Control']='no-store'
            if body is not None:headers.update({'Content-Type':mime,'Content-Length':str(len(body))})
            if method=='POST':headers['x-upsert']='false'
            deadline=wire._monotonic()+wire._timeout
            request=Request(url,data=body,headers=headers,method=method)
            # Once this entry is called, even a transport exception is unknown.
            # Never infer zero dispatch from a timeout or provider error code.
            dispatched=True
            try:response=wire._open(request)
            except HTTPError as error:response=error
            wire._deadline(deadline)
            if response.geturl()!=url or 300<=response.status<400 or wire._header(response,'Content-Encoding') not in (None,'identity') or wire._header(response,'Content-Range') is not None:raise safe_error()
            content=wire._bounded(response,maximum,deadline)
            if not self.protection_verified:raise safe_error()
            return response.status,content,wire._header(response,'Content-Type')
        except Exception:
            if method=='DELETE' and not dispatched:
                raise ContributionDeleteNotDispatched() from None
            raise safe_error() from None
        finally:
            if response is not None:
                try:response.close()
                except Exception:pass
    @staticmethod
    def _json(raw):
        try:return json.loads(raw.decode('utf-8'))
        except Exception:raise safe_error() from None
    def _private_bucket(self):
        status,raw,_=self._request('GET','bucket/'+self.bucket)
        value=self._json(raw)
        if status!=200 or not isinstance(value,dict) or value.get('id')!=self.bucket or value.get('public') is not False:raise safe_error()
    @staticmethod
    def _version(version):
        if not isinstance(version,str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',version):raise safe_error()
        return version
    def inspect(self,object_id,expected_size,version=None):
        path=object_path(object_id)
        if type(expected_size) is not int or not 1<=expected_size<=MAX_IMAGE:raise safe_error()
        self._private_bucket() # Same service credential, not a user-hidden 404.
        suffix='?versionId='+self._version(version) if version is not None else ''
        status,raw,_=self._request('GET',f'object/info/authenticated/{self.bucket}/{path}{suffix}')
        value=self._json(raw)
        if _object_missing(status,value):return None
        if status!=200 or not isinstance(value,dict) or value.get('name')!=path or value.get('bucket_id')!=self.bucket or value.get('size')!=expected_size or value.get('content_type')!='image/png' or value.get('is_delete_marker') is True:raise safe_error()
        actual=self._version(value.get('version'))
        if version is not None and version!=actual:raise safe_error()
        status,content,mime=self._request('GET',f'object/authenticated/{self.bucket}/{path}?versionId={actual}',maximum=expected_size)
        if status!=200 or (mime or '').split(';')[0]!='image/png' or len(content)!=expected_size:raise safe_error()
        return StoredContribution(content,actual)
    def read(self,object_id,expected_size):
        found=self.inspect(object_id,expected_size)
        if found is None:raise safe_error()
        return found.content
    def put(self,object_id,content):
        path=object_path(object_id)
        if not isinstance(content,bytes) or not 1<=len(content)<=MAX_IMAGE:raise safe_error()
        self._private_bucket()
        status,raw,_=self._request('POST',f'object/{self.bucket}/{path}',content,'image/png')
        ack=self._json(raw)
        if status not in (200,201) or not isinstance(ack,dict) or ack.get('Key')!=f'{self.bucket}/{path}':raise safe_error()
        found=self.inspect(object_id,len(content))
        if found is None or found.content!=content:raise safe_error()
    def remove(self,object_id,expected_size,version):
        try:
            path=object_path(object_id);version=self._version(version)
            self._private_bucket()
            body=json.dumps({'prefixes':[{'path':path,'versionId':version}]},separators=(',',':')).encode()
        except Exception:
            # Bucket validation is read-only; no DELETE can have occurred yet.
            raise ContributionDeleteNotDispatched() from None
        # Exact version removes bytes even on a versioned bucket; plain remove may
        # only add a delete marker. Unsupported provider versions remain unknown.
        status,raw,_=self._request('DELETE','object/'+self.bucket,body,'application/json')
        ack=self._json(raw)
        if status!=200 or not isinstance(ack,list) or len(ack)!=1 or not isinstance(ack[0],dict) or ack[0].get('name')!=path or ack[0].get('version')!=version:raise safe_error()
