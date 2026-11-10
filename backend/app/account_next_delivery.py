"""Review SMTP adapter; explicit EXISTING settings, no new credentials/env.

Separate from existing verification/recovery/binding templates. No retry.
Tests replace both SMTP transports; importing this module sends nothing.
"""
import re
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr
from app.email_delivery import SmtpDelivery, canonical_email

PURPOSES = {
    'channel-old': ('确认更换邮箱', '确认把当前登录邮箱更换为你在弓行记刚输入的新邮箱'),
    'channel-new': ('验证新邮箱', '验证你在弓行记刚输入的新登录邮箱；仍需完成旧邮箱确认'),
    'phone-authority': ('授权更换手机', '用当前已验证邮箱授权更换此账号的手机号；新手机号仍需单独验证'),
}


def message_for(settings, address, token, purpose):
    length = 8 if purpose in ('channel-old','channel-new') else 6 if purpose=='phone-authority' else None
    if canonical_email(address) != address or length is None or not isinstance(token,str) or not re.fullmatch(r'[0-9]{%d}'%length,token):
        raise RuntimeError('Channel email unavailable')
    subject, operation = PURPOSES[purpose]
    message = EmailMessage()
    message['From'] = formataddr(('弓行记',settings.sender))
    message['To'] = address
    message['Subject'] = '弓行记 · '+subject
    message.set_content(f'你正在{operation}。\n验证码：{token}\n本次操作须在开始后 5 分钟内完成。\n请仅在弓行记本次账号安全操作中输入，不要转发。若不是你本人操作，请忽略本邮件。')
    return message


class ChannelChangeDelivery(SmtpDelivery):
    def __init__(self, existing_settings):
        super().__init__(existing_settings)  # never loads .env/account secrets

    def send(self,address,token,purpose):
        if not self.ready():
            raise RuntimeError('Channel email unavailable')
        message = message_for(self.settings,address,token,purpose)
        context=ssl.create_default_context();connection=None
        try:
            if self.settings.port==465:
                connection=smtplib.SMTP_SSL(self.settings.host,465,timeout=2,context=context)
            else:
                connection=smtplib.SMTP(self.settings.host,587,timeout=2)
                connection.ehlo();connection.starttls(context=context);connection.ehlo()
            connection.login(self.settings.username,self.settings.password)
            if connection.send_message(message):
                raise RuntimeError('Channel email refused')
        except Exception:
            raise RuntimeError('Channel email delivery unknown') from None
        finally:
            if connection is not None:
                connection.close()
