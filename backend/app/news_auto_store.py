"""One atomic public-news snapshot; never reads user/account/training tables."""
import time
import uuid
import json
from sqlalchemy import text
from .news_auto import baseline, validate, encode, digest

class NewsStore:
    def __init__(self, sessions):
        self.sessions = sessions

    @staticmethod
    def table(session):
        # Fixed identifiers, never request-controlled SQL fragments.
        dialect = session.get_bind().dialect.name
        if dialect == 'postgresql':
            return 'news_private.publication'
        if dialect == 'sqlite':
            return 'publication'
        raise RuntimeError('NEWS_DATABASE_UNSUPPORTED')

    def read(self):
        with self.sessions() as s:
            row = s.execute(text(f'SELECT payload, content_sha FROM {self.table(s)} WHERE id=1')).mappings().first()
            if not row:
                raise RuntimeError('NEWS_NOT_INITIALIZED')
            bundle = validate(json.loads(row['payload']))
            if digest(bundle) != row['content_sha']:
                raise RuntimeError('NEWS_STORAGE_INTEGRITY')
            return bundle

    def claim(self, day, now=None):
        now = int(time.time()) if now is None else now
        token = uuid.uuid4().hex
        seed = baseline()
        with self.sessions() as s:
            table = self.table(s)
            s.execute(text(f'INSERT INTO {table}(id,payload,content_sha,revision) VALUES(1,:payload,:sha,1) ON CONFLICT(id) DO NOTHING'),
                      {'payload': encode(seed).decode(), 'sha': digest(seed)})
            count = s.execute(text(f'UPDATE {table} SET lease_token=:token,lease_until=:until WHERE id=1 AND (lease_until IS NULL OR lease_until<=:now) AND (checked_day IS NULL OR checked_day<>:day)'),
                              {'token': token, 'until': now + 120, 'now': now, 'day': day}).rowcount
            if count != 1:
                s.rollback()
                return None
            row = s.execute(text(f'SELECT payload,content_sha FROM {table} WHERE id=1')).mappings().one()
            current = validate(json.loads(row['payload']))
            if digest(current) != row['content_sha']:
                raise RuntimeError('NEWS_STORAGE_INTEGRITY')
            s.commit()
            return token, row['content_sha'], current

    def publish(self, token, prior_sha, bundle, day, now=None):
        validate(bundle)
        expected = digest(bundle)
        now = int(time.time()) if now is None else now
        with self.sessions() as s:
            table = self.table(s)
            count = s.execute(text(f'''UPDATE {table} SET
                previous_payload=CASE WHEN content_sha<>:sha THEN payload ELSE previous_payload END,
                previous_sha=CASE WHEN content_sha<>:sha THEN content_sha ELSE previous_sha END,
                payload=:payload,content_sha=:sha,revision=:revision,checked_day=:day,
                lease_token=NULL,lease_until=NULL
                WHERE id=1 AND lease_token=:token AND content_sha=:prior AND lease_until>:now
                AND (revision+1=:revision OR (revision=:revision AND content_sha=:sha))'''),
                {'payload': encode(bundle).decode(), 'sha': expected, 'revision': bundle['feed']['revision'],
                 'day': day, 'token': token, 'prior': prior_sha, 'now': now}).rowcount
            if count != 1:
                s.rollback()
                raise RuntimeError('NEWS_LEASE_LOST')
            try:
                s.commit()
            except Exception:
                # Unknown commits are verified through a fresh read, never replayed.
                s.close()
                with self.sessions() as verification:
                    confirmed = verification.execute(text(f'SELECT payload,content_sha,checked_day,lease_token FROM {self.table(verification)} WHERE id=1')).mappings().one()
                    matches = (confirmed['content_sha'] == expected and confirmed['checked_day'] == day and
                               confirmed['lease_token'] is None and digest(validate(json.loads(confirmed['payload']))) == expected)
                if not matches:
                    raise RuntimeError('NEWS_COMMIT_UNKNOWN') from None
        return expected

    def release(self, token):
        with self.sessions() as s:
            s.execute(text(f'UPDATE {self.table(s)} SET lease_token=NULL,lease_until=NULL WHERE id=1 AND lease_token=:token'), {'token': token})
            s.commit()
