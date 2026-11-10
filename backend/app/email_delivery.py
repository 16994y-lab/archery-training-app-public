"""Use Python's maintained SMTP client; never operate a mail server.

Only operator-configured TLS SMTP is accepted. No body, recipient, credential
or provider exception is written to logs or returned by the public API.
"""
from __future__ import annotations

import os
import re
import smtplib
import ssl
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr


def canonical_email(value):
    if not isinstance(value, str):
        return None
    address=value.strip().lower()
    if (len(address)>254 or not address.isascii()
            or not re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}",address)
            or '..' in address):
        return None
    return address


@dataclass(frozen=True)
class SmtpSettings:
    host: str=''
    port: int=0
    username: str=''
    password: str=''
    sender: str=''

    @classmethod
    def from_env(cls):
        try:
            port=int(os.getenv('EMAIL_SMTP_PORT','0'))
        except ValueError:
            port=0
        return cls(os.getenv('EMAIL_SMTP_HOST',''),port,os.getenv('EMAIL_SMTP_USERNAME',''),
                   os.getenv('EMAIL_SMTP_PASSWORD',''),os.getenv('EMAIL_SMTP_FROM',''))

    def ready(self):
        return (bool(re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?',self.host))
                and self.port in (465,587) and bool(self.username) and bool(self.password)
                and canonical_email(self.sender)==self.sender)


class SmtpDelivery:
    def __init__(self,settings=None):
        self.settings=settings or SmtpSettings.from_env()

    def ready(self):
        return self.settings.ready()

    def send(self,email,token,purpose):
        if (not self.ready() or canonical_email(email)!=email
                or not isinstance(token,str) or not re.fullmatch(r'[0-9]{6,10}',token)
                or purpose not in ('verification','recovery','binding','login')):
            raise RuntimeError('Email delivery is unavailable')
        message=EmailMessage()
        message['From']=formataddr(('弓行记',self.settings.sender))
        message['To']=email
        message['Subject']={'verification':'弓行记 · 验证邮箱','binding':'弓行记 · 绑定邮箱','recovery':'弓行记 · 找回密码','login':'弓行记 · 邮箱登录验证码'}[purpose]
        operation={'verification':'验证账号安全邮箱','binding':'为原手机账号绑定邮箱','recovery':'找回账号密码','login':'登录原已验证账号'}[purpose]
        # Recovery expiry is controlled by Supabase; do not invent an expiry.
        expiry='验证码在 5 分钟内有效。\n' if purpose=='verification' else '请在本次绑定开始后 5 分钟内完成，超时请回到账号安全重新开始。\n' if purpose=='binding' else ''
        message.set_content(f'你正在{operation}。\n验证码：{token}\n{expiry}请仅在弓行记输入验证码，不要转发。若不是你本人操作，请忽略本邮件。')
        context=ssl.create_default_context()
        connection=None
        try:
            if self.settings.port==465:
                connection=smtplib.SMTP_SSL(self.settings.host,465,timeout=2,context=context)
            else:
                connection=smtplib.SMTP(self.settings.host,587,timeout=2)
                connection.ehlo()
                connection.starttls(context=context)
                connection.ehlo()
            connection.login(self.settings.username,self.settings.password)
            refused=connection.send_message(message)
            if refused:
                raise RuntimeError('Email delivery is unavailable')
        except Exception:
            raise RuntimeError('Email delivery could not be confirmed') from None
        finally:
            if connection is not None:
                # close() has no network round trip after successful delivery.
                connection.close()
