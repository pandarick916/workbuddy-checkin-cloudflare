@echo off
python -c "import json,os,sys; p=os.path.join(os.environ['LOCALAPPDATA'],'CodeBuddyExtension','Data','Public','auth','workbuddy-desktop.info'); sys.stdout.write(json.load(open(p,encoding='utf-8'))['auth']['accessToken'])" | clip
echo WorkBuddy accessToken 已复制到剪贴板。
echo 接着运行： wrangler secret put WORKBUDDY_TOKEN   （提示处 Ctrl+V 粘贴，回车）
