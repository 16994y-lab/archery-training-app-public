"""Package the offline web export as an independently signed Android debug APK."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
BUILD = HERE / "build"
LOCAL = HERE / ".local"
KEYSTORE = LOCAL / "offline-dev.p12"
APP_ID = "app.gongxingji.training.offline"
APK_NAME = "Gongxingji-offline-dev.apk"
MIN_API = "26"
ASSET_PATH = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*(/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*")
ASSET_TYPES = {".html", ".js", ".mjs", ".css", ".json", ".webmanifest", ".svg", ".png", ".jpg",
               ".jpeg", ".webp", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".otf"}


def cli():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk", type=Path, help="Android SDK root (otherwise ANDROID_HOME or a standard SDK location)")
    parser.add_argument("--jdk", type=Path, help="JDK root (otherwise JAVA_HOME or javac on PATH)")
    parser.add_argument("--android-jar", type=Path, help="Override the SDK platform JAR (default platforms/android-35/android.jar)")
    parser.add_argument("--build-tools", type=Path, help="Override the Build Tools directory (default build-tools/35.0.0)")
    return parser.parse_args()


def sdk_root(explicit):
    if explicit:
        return explicit
    for name in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        if os.environ.get(name):
            return Path(os.environ[name])
    candidates = [Path.home() / "Library/Android/sdk", Path.home() / "Android/Sdk"]
    if os.environ.get("LOCALAPPDATA"):
        candidates.insert(0, Path(os.environ["LOCALAPPDATA"]) / "Android/Sdk")
    return next((path for path in candidates if path.is_dir()), None)


def jdk_bin(explicit):
    if explicit:
        return explicit / "bin"
    if os.environ.get("JAVA_HOME"):
        return Path(os.environ["JAVA_HOME"]) / "bin"
    javac = shutil.which("javac")
    if not javac:
        raise ValueError("JDK not found. Set JAVA_HOME or pass --jdk.")
    return Path(javac).parent


def required(path):
    if not path.is_file():
        raise ValueError(f"Required tool or input is missing: {path}")
    return path.resolve()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def run(*command):
    return subprocess.run([str(value) for value in command], check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, encoding="utf-8", errors="replace").stdout


def copy_assets(destination):
    source = PROJECT / "frontend/dist-offline-android"
    if not source.is_dir() or source.is_symlink() or not (source / "mobile.html").is_file():
        raise ValueError("Build frontend/dist-offline-android/mobile.html before packaging the APK.")
    assets = {}
    for file in sorted(source.rglob("*")):
        if file.is_symlink():
            raise ValueError(f"Linked frontend asset is not allowed: {file.relative_to(source)}")
        if not file.is_file():
            continue
        relative = file.relative_to(source).as_posix()
        if (not ASSET_PATH.fullmatch(relative) or file.suffix not in ASSET_TYPES
                or (file.suffix == ".html" and relative != "mobile.html")):
            raise ValueError(f"Unsupported offline asset: {relative}")
        data = file.read_bytes()
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        assets["assets/www/" + relative] = sha(data)
    return assets


def ensure_keystore(keytool, staging):
    if KEYSTORE.is_symlink():
        raise ValueError("Refusing a linked debug keystore.")
    if KEYSTORE.is_file():
        return
    new_key = staging / "offline-dev.p12"
    run(keytool, "-genkeypair", "-noprompt", "-storetype", "PKCS12", "-keystore", new_key,
        "-storepass", "android", "-keypass", "android", "-alias", "offline-dev",
        "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000", "-dname", "CN=Gongxingji Offline Debug")
    new_key.chmod(0o600)
    try:
        if os.name == "nt":
            # Windows rename is atomic and fails when the destination exists.
            new_key.rename(KEYSTORE)
        else:
            os.link(new_key, KEYSTORE)
    except FileExistsError:
        if not KEYSTORE.is_file() or KEYSTORE.is_symlink():
            raise


def build(args):
    sdk = sdk_root(args.sdk)
    if sdk is None and (args.android_jar is None or args.build_tools is None):
        raise ValueError("Android SDK not found. Set ANDROID_HOME or pass --sdk.")
    android = required(args.android_jar or sdk / "platforms/android-35/android.jar")
    tools = args.build_tools or sdk / "build-tools/35.0.0"
    jdk = jdk_bin(args.jdk)
    suffix = ".exe" if os.name == "nt" else ""
    java, javac, keytool = [required(jdk / (name + suffix)) for name in ("java", "javac", "keytool")]
    aapt2, zipalign = [required(tools / (name + suffix)) for name in ("aapt2", "zipalign")]
    d8, apksigner = [required(tools / "lib" / (name + ".jar")) for name in ("d8", "apksigner")]
    for folder in (BUILD, LOCAL):
        if folder.is_symlink():
            raise ValueError(f"Refusing a linked output folder: {folder}")
        folder.mkdir(exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="offline-build-", dir=BUILD) as work:
        staging = Path(work)
        assets = copy_assets(staging / "assets/www")
        classes = staging / "classes"
        dex = staging / "dex"
        classes.mkdir()
        dex.mkdir()
        activity = required(HERE / "src/app/gongxingji/training/offline/MainActivity.java")
        manifest = required(HERE / "AndroidManifest.xml")
        unsigned, aligned, signed = [staging / name for name in ("unsigned.apk", "aligned.apk", APK_NAME)]
        run(javac, "-encoding", "UTF-8", "-source", "8", "-target", "8",
            "-bootclasspath", android, "-d", classes, activity)
        run(java, "-cp", d8, "com.android.tools.r8.D8", "--min-api", MIN_API, "--lib", android,
            "--output", dex, *sorted(classes.rglob("*.class")))
        run(aapt2, "link", "--manifest", manifest, "-I", android, "-A", staging / "assets", "-o", unsigned)
        with ZipFile(unsigned, "a", compression=ZIP_DEFLATED) as archive:
            archive.write(required(dex / "classes.dex"), "classes.dex")
        run(zipalign, "-f", "4", unsigned, aligned)
        ensure_keystore(keytool, staging)
        run(java, "-jar", apksigner, "sign", "--ks", KEYSTORE, "--ks-key-alias", "offline-dev",
            "--ks-pass", "pass:android", "--key-pass", "pass:android",
            "--v2-signing-enabled", "true", "--v3-signing-enabled", "true", "--out", signed, aligned)
        run(zipalign, "-c", "4", signed)
        certs = run(java, "-jar", apksigner, "verify", "--verbose", "--print-certs", signed)
        match = re.search(r"Signer #1 certificate SHA-256 digest: ([0-9a-fA-F]{64})", certs)
        if not match or not re.search(r"Verified using v2 scheme[^\n]*: true", certs):
            raise ValueError("APK signature readback failed.")
        manifest_check = run(aapt2, "dump", "badging", signed)
        if f"package: name='{APP_ID}'" not in manifest_check or re.search(r"(?m)^uses-permission", manifest_check):
            raise ValueError("APK must use the standalone app ID and request no permissions.")
        if "application-debuggable" not in manifest_check or "launchable-activity:" not in manifest_check:
            raise ValueError("APK must contain a launchable developer activity.")
        with ZipFile(signed) as archive:
            content = {name: sha(archive.read(name)) for name in archive.namelist() if name.startswith("assets/www/")}
        if content != assets:
            raise ValueError("APK web assets did not match the frontend export.")
        result = {"applicationId": APP_ID, "sha256": sha(signed.read_bytes()), "bytes": signed.stat().st_size,
                  "certificateSha256": match.group(1).lower(), "permissions": [], "assetCount": len(assets)}
        receipt = staging / "build-result.json"
        receipt.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        signed.replace(BUILD / APK_NAME)
        receipt.replace(BUILD / receipt.name)
    print(f"APK: {BUILD / APK_NAME}")
    print(f"SHA-256: {result['sha256']}")


if __name__ == "__main__":
    try:
        build(cli())
    except subprocess.CalledProcessError as error:
        raise SystemExit(f"Android build command failed ({error.returncode}):\n{error.stdout}") from None
    except (OSError, ValueError) as error:
        raise SystemExit(str(error)) from None
