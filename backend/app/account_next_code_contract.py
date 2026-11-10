"""Exact channel/leg contracts. Not global Auth OTP configuration."""
import re
def channel_code_length(kind,leg):
    if kind=='email' and leg in ('old','new'):return 8
    if kind=='phone' and leg in ('authority','new'):return 6
    return None
def valid_channel_code(kind,leg,token):
    length=channel_code_length(kind,leg)
    return length is not None and isinstance(token,str) and re.fullmatch(r'[0-9]{%d}'%length,token) is not None
