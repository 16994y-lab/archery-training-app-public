"""Bound actual UTF-8 response bytes before any cloud archive mutation."""
from fastapi import HTTPException
from fastapi.responses import JSONResponse

TRANSPORT_JSON_MAX_BYTES = 4_000_000
CAPACITY_MESSAGE = "在线备份完整 JSON 超过 4,000,000 字节；请保留本机资料并导出备份文件"

def bounded_backup_response(result):
    try:
        response = JSONResponse(result, headers={"Cache-Control": "no-store", "ETag": f'"{result["revision"]}"'})
    except (ValueError, UnicodeError, TypeError, OverflowError, RecursionError) as error:
        raise HTTPException(422, "云备份不能安全编码；请保留原资料", headers={"Cache-Control": "no-store"}) from error
    if len(response.body) > TRANSPORT_JSON_MAX_BYTES:
        raise HTTPException(413, CAPACITY_MESSAGE, headers={"Cache-Control": "no-store"})
    return response
