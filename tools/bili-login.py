"""User-operated QR login. Never invoked by the model or application."""
import asyncio
import json
import os
from pathlib import Path
from bilibili_api.login_v2 import QrCodeLogin, QrCodeLoginEvents

ROOT = Path(__file__).resolve().parent.parent
FOLDER = ROOT / 'data' / 'bili'
CREDENTIAL = FOLDER / 'bili_credential.json'
QR = FOLDER / 'qrcode_login.png'

async def main():
    FOLDER.mkdir(parents=True, exist_ok=True)
    if CREDENTIAL.exists() and input('已存在 B 站凭据。重新登录并替换？输入 YES 继续：').strip() != 'YES':
        print('已取消。'); return
    login = QrCodeLogin()
    try:
        await login.generate_qrcode()
        QR.write_bytes(login.get_qrcode_picture().content)
        os.startfile(str(QR))
        print('请用 B 站手机 App 扫描打开的二维码，并在手机上确认。二维码过期后可重新运行。')
        for _ in range(90):
            state = await login.check_state()
            if state == QrCodeLoginEvents.TIMEOUT:
                print('二维码已过期。'); return
            if state == QrCodeLoginEvents.DONE:
                cred = login.get_credential()
                temp = CREDENTIAL.with_suffix('.json.tmp')
                try:
                    with temp.open('w', encoding='utf-8') as file:
                        json.dump({'sessdata':cred.sessdata,'bili_jct':cred.bili_jct,'buvid3':cred.buvid3,'dedeuserid':cred.dedeuserid},file)
                    os.replace(temp,CREDENTIAL)
                finally:
                    temp.unlink(missing_ok=True)
                print('登录完成，凭据已保存到本目录的私密数据区。'); return
            await asyncio.sleep(2)
        print('登录等待超时。')
    finally:
        QR.unlink(missing_ok=True)

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print('\n已取消。')
    except Exception:
        print('登录未完成，请检查网络后重试。')
