#!/usr/bin/env python3
"""把语音助手 workflow 用「文件法」装进 Alfred，并保证 fallback 第一位 + 主热键 ⌘Space（幂等）。

格式依据（2026-10-01 查实，见 CLAUDE.md「Alfred 偏好格式」）：
- workflow：Alfred.alfredpreferences/workflows/user.workflow.<UUID>/info.plist
- fallback：preferences/features/defaultresults/prefs.plist 的 fallbacks 数组，
  workflow 项写作 user.workflow.<目录UUID>.<fallback 触发器 uid>
- 主热键：preferences/local/<机器 hash>/hotkey/prefs.plist = {default: {key: 49, mod: 1048576, string: "Space"}}
改 prefs 前先优雅退出 Alfred 并轮询到进程真的退出（否则 Alfred 退出时会把旧 prefs 写回），改完再打开；
只有确实需要改时才退出。本机目录 preferences/local/<hash> 不存在时先启动一次 Alfred 等它生成。
装完用外部触发 va 发一次自检参数（va 只写标记文件，无副作用）验证整条链路；失败退出码 1。
"""
import os
import plistlib
import shutil
import subprocess
import sys
import time
import uuid

BUNDLE = os.environ.get('VA_BUNDLE_PREFIX', 'local.voice-agent') + '.voice-agent'
FALLBACK_UID = '6C1F7A10-2B7E-4C2A-9D11-0A1B2C3D4E01'
DEFAULT_FALLBACKS = ['features.websearch.google.fallback', 'features.websearch.wiki.fallback', 'features.websearch.amazon.fallback']
CMD_SPACE = {'key': 49, 'mod': 1048576, 'string': 'Space'}


def say(s):
    print(f'[alfred-install] {s}')


ALFRED_PROC = 'Alfred 5.app/Contents/MacOS/Alfred'


def alfred_running():
    return subprocess.run(['pgrep', '-f', ALFRED_PROC], capture_output=True).returncode == 0


def wait_until(pred, timeout, step=0.3):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if pred():
            return True
        time.sleep(step)
    return pred()


def quit_alfred():
    """优雅退出并轮询到进程真的没了；超时返回 False（此时绝不写 prefs，Alfred 退出时会把内存里的旧 prefs 写回去）"""
    if not alfred_running():
        return True
    subprocess.run(['osascript', '-e', 'quit app "Alfred 5"'], check=False)
    return wait_until(lambda: not alfred_running(), 20)


def ensure_machine_dir(local):
    """preferences/local/<机器 hash> 由 Alfred 首次启动时生成；没有就启动一次 Alfred 等它生成"""
    hashes = os.listdir(local) if os.path.isdir(local) else []
    if hashes:
        return hashes
    say('还没有本机目录 preferences/local/<hash>：启动一次 Alfred 等它生成（最多 30 秒）')
    subprocess.run(['open', '-a', 'Alfred 5'], check=False)
    wait_until(lambda: os.path.isdir(local) and len(os.listdir(local)) > 0, 30)
    return os.listdir(local) if os.path.isdir(local) else []


def selftest(root, timeout=10):
    """装完用外部触发调用一次 va 自检参数：va 只写一个标记文件，不调模型、不执行动作"""
    nonce = f'i{int(time.time())}{os.getpid()}'
    marker = os.path.join(root, 'logs', f'.selftest-{nonce}')
    script = ('on run argv\ntell application id "com.runningwithcrayons.Alfred" to run trigger "va" '
              'in workflow "' + BUNDLE + '" with argument (item 1 of argv)\nend run')
    # Alfred 刚启动/刚重载 workflow 时外部触发可能还没注册，重试几次
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = subprocess.run(['osascript', '-e', script, f'__va_selftest__ {nonce}'], capture_output=True, text=True, timeout=15)
        if r.returncode == 0 and wait_until(lambda: os.path.exists(marker), 4, 0.2):
            os.unlink(marker)
            say(f'自检通过：Alfred 外部触发 → workflow → bin/va（{time.time() - t0:.1f}s）')
            return True
        time.sleep(1)
    say(f'自检失败：外部触发后 bin/va 没回标记（osascript rc={r.returncode} {r.stderr.strip()[:120]}）；跑 va doctor 看详情')
    return False


def load(p, d):
    try:
        with open(p, 'rb') as f:
            return plistlib.load(f)
    except FileNotFoundError:
        return d


def main():
    src = sys.argv[1]
    prefs_root = os.path.expanduser('~/Library/Application Support/Alfred/Alfred.alfredpreferences')
    pj = os.path.expanduser('~/Library/Application Support/Alfred/prefs.json')
    if os.path.exists(pj):
        import json
        cur = json.load(open(pj)).get('current')
        if cur:
            prefs_root = cur
    if not os.path.isdir(prefs_root):
        say(f'没找到 Alfred 偏好目录 {prefs_root}（Alfred 5 装了吗？），跳过')
        return 0
    wf_root = os.path.join(prefs_root, 'workflows')
    os.makedirs(wf_root, exist_ok=True)

    # 找已装的同 bundleid workflow，复用目录（目录 UUID 稳定 → fallback 引用稳定）
    wf_dir = None
    for d in sorted(os.listdir(wf_root)):
        info = os.path.join(wf_root, d, 'info.plist')
        if os.path.isfile(info) and load(info, {}).get('bundleid') == BUNDLE:
            wf_dir = os.path.join(wf_root, d)
            break
    new_info = open(src, 'rb').read()
    if wf_dir is None:
        wf_dir = os.path.join(wf_root, f'user.workflow.{str(uuid.uuid4()).upper()}')
        os.makedirs(wf_dir)
        say(f'新装 workflow → {os.path.basename(wf_dir)}')
    target = os.path.join(wf_dir, 'info.plist')
    if not os.path.exists(target) or open(target, 'rb').read() != new_info:
        shutil.copyfile(src, target)
        say('workflow info.plist 已更新')
    wf_uuid = os.path.basename(wf_dir).replace('user.workflow.', '')
    fb_id = f'user.workflow.{wf_uuid}.{FALLBACK_UID}'

    # 需要改的 prefs
    dr_path = os.path.join(prefs_root, 'preferences/features/defaultresults/prefs.plist')
    dr = load(dr_path, {})
    fbs = dr.get('fallbacks') or list(DEFAULT_FALLBACKS)
    want_fbs = [fb_id] + [x for x in fbs if x != fb_id and not x.endswith(f'.{FALLBACK_UID}')]
    need_dr = fbs != want_fbs or 'fallbacks' not in dr

    need_hk = False
    hk_path = None
    if os.environ.get('NO_HOTKEY') != '1':
        local = os.path.join(prefs_root, 'preferences/local')
        hashes = ensure_machine_dir(local)
        if len(hashes) == 1:
            hk_path = os.path.join(local, hashes[0], 'hotkey/prefs.plist')
            need_hk = load(hk_path, {}).get('default') != CMD_SPACE
        else:
            say(f'preferences/local 下有 {len(hashes)} 个机器目录，无法确定本机，主热键请在 Alfred 偏好里手动设 ⌘Space')

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if not (need_dr or need_hk):
        say('fallback 与主热键已就位')
        if not alfred_running():
            subprocess.run(['open', '-a', 'Alfred 5'], check=False)
            wait_until(alfred_running, 15)
        return 0 if selftest(root) else 1
    if not quit_alfred():
        say('Alfred 20 秒内没退出，放弃修改 prefs（退出时它会把旧 prefs 写回去）；手动退出 Alfred 后重跑 bin/va-setup')
        return 1
    if need_dr:
        dr['fallbacks'] = want_fbs
        os.makedirs(os.path.dirname(dr_path), exist_ok=True)
        with open(dr_path, 'wb') as f:
            plistlib.dump(dr, f)
        say('fallback 第一位 = 语音助手')
    if need_hk and hk_path:
        os.makedirs(os.path.dirname(hk_path), exist_ok=True)
        hk = load(hk_path, {})
        hk['default'] = CMD_SPACE
        with open(hk_path, 'wb') as f:
            plistlib.dump(hk, f)
        say('Alfred 主热键 = ⌘Space（Spotlight 的 ⌘Space 需在 系统设置→键盘→键盘快捷键→聚焦 里自己关掉）')
    subprocess.run(['open', '-a', 'Alfred 5'], check=False)
    wait_until(alfred_running, 15)
    return 0 if selftest(root) else 1


if __name__ == '__main__':
    sys.exit(main())
