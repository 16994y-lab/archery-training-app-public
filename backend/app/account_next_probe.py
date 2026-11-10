"""One bounded reviewed experiment. No IO or normal Hosted acceptance."""
from dataclasses import dataclass
import hmac,re
from uuid import UUID

@dataclass(frozen=True,repr=False)
class ContractProbe:
    owner: str
    intent: str
    target_digest: str
    start_unix: int
    expires_unix: int
    approval_sha256: str
    secure_email_change_confirmed: bool
    email_baseline: int = 4
    def __post_init__(self):
        try:
            if (str(UUID(self.owner))!=self.owner or not UUID(self.owner).int
                or str(UUID(self.intent))!=self.intent or not UUID(self.intent).int
                or not re.fullmatch('[0-9a-f]{64}',self.target_digest)
                or not re.fullmatch('[0-9a-f]{64}',self.approval_sha256)
                or type(self.start_unix) is not int or type(self.expires_unix) is not int
                or self.start_unix<=0 or not 0 < self.expires_unix-self.start_unix <= 300
                or self.secure_email_change_confirmed is not True
                or type(self.email_baseline) is not int or self.email_baseline!=4):
                raise ValueError('invalid_contract_probe_scope')
        except (ValueError,TypeError,AttributeError):
            raise ValueError('invalid_contract_probe_scope') from None
    def owner_live(self,owner,now):
        return owner==self.owner and self.start_unix<=now<self.expires_unix
    def target_matches(self,digest):
        return isinstance(digest,str) and hmac.compare_digest(digest,self.target_digest)
    def intent_matches(self,op):
        return (str(op['owner'])==self.owner and str(op['intent'])==self.intent
            and op['kind']=='email' and op['authority_kind']=='email'
            and self.target_matches(op['target_digest'])
            and op['created_at'].timestamp()>=self.start_unix
            and op['expires_at'].timestamp()<=self.expires_unix)
    def action_ledger_matches(self,count):return count in (4,6)
    def pair_ledger_matches(self,count):return count==4

def from_environment(environ):
    if environ.get('ACCOUNT_CHANNEL_CONTRACT_PROBE_ENABLED')!='1':return None
    if any(environ.get(k)=='1' for k in ('ACCOUNT_CHANNEL_CHANGE_ENABLED',
        'ACCOUNT_CHANNEL_EMAIL_CHANGE_ENABLED','ACCOUNT_CHANNEL_PHONE_CHANGE_ENABLED',
        'ACCOUNT_INVITATIONS_ENABLED','ACCOUNT_CHANNEL_HOSTED_CONTRACT_VERIFIED')):
        raise ValueError('probe_and_normal_capabilities_must_not_overlap')
    if environ.get('ACCOUNT_NEXT_GUARD_ENABLED')!='1':raise ValueError('probe_requires_native_fence')
    try:
        return ContractProbe(environ.get('ACCOUNT_CHANNEL_CONTRACT_PROBE_OWNER',''),
            environ.get('ACCOUNT_CHANNEL_CONTRACT_PROBE_INTENT',''),
            environ.get('ACCOUNT_CHANNEL_CONTRACT_PROBE_TARGET_DIGEST',''),
            int(environ.get('ACCOUNT_CHANNEL_CONTRACT_PROBE_START_UNIX','')),
            int(environ.get('ACCOUNT_CHANNEL_CONTRACT_PROBE_EXPIRES_UNIX','')),
            environ.get('ACCOUNT_CHANNEL_CONTRACT_PROBE_APPROVAL_SHA256',''),
            environ.get('ACCOUNT_CHANNEL_CONTRACT_PROBE_SECURE_EMAIL_CHANGE_CONFIRMED')=='1')
    except (ValueError,TypeError):raise ValueError('invalid_contract_probe_scope') from None
