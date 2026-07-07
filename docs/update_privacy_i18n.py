import os

files = [
    ("privacy-windows.html", "privacy_tag_win"),
    ("privacy-macos.html", "privacy_tag_mac"),
    ("privacy-ios.html", "privacy_tag_ios"),
    ("privacy-android.html", "privacy_tag_android")
]

for filename, tag in files:
    filepath = os.path.join("/Users/barretlin/GitProjects/OCR/docs", filename)
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    # Add language switcher to header
    header_replacement = """    <header>
        <a href="index.html" class="logo">
            <img src="app_icon.jpg" alt="OCREditor Logo" style="width: 32px; height: 32px; border-radius: 8px; object-fit: cover;">
            OCREditor
        </a>
        <select id="lang-select" style="background: var(--bg-surface); color: white; border: 1px solid var(--text-muted); padding: 4px; border-radius: 4px;">
            <option value="en">English</option>
            <option value="zh-TW">繁體中文</option>
            <option value="zh-CN">简体中文</option>
            <option value="ja">日本語</option>
            <option value="ko">한국어</option>
            <option value="th">ไทย</option>
            <option value="es">Español</option>
            <option value="pt">Português</option>
            <option value="ms">Bahasa Melayu</option>
            <option value="ru">Русский</option>
            <option value="de">Deutsch</option>
        </select>
    </header>"""
    import re
    content = re.sub(r"<header>.*?</header>", header_replacement, content, flags=re.DOTALL)

    # Replace specific elements with data-i18n tags
    content = content.replace("<h1>隱私權與資料保護政策</h1>", '<h1 data-i18n="privacy_h1">隱私權與資料保護政策</h1>')
    content = re.sub(r'<div class="platform-tag">.*?</div>', f'<div class="platform-tag" data-i18n="{tag}">\\g<0></div>', content)
    
    content = content.replace("<p>本隱私權政策旨在說明", '<p data-i18n="privacy_intro">本隱私權政策旨在說明')
    
    content = content.replace("<h2>1. 資料的收集與處理</h2>", '<h2 data-i18n="privacy_h2_1">1. 資料的收集與處理</h2>')
    content = content.replace("<li><strong>完全離線執行：", '<li data-i18n="privacy_li_1_1"><strong>完全離線執行：')
    content = content.replace("<li><strong>零伺服器傳輸：", '<li data-i18n="privacy_li_1_2"><strong>零伺服器傳輸：')
    content = content.replace("<li><strong>無追蹤程式碼：", '<li data-i18n="privacy_li_1_3"><strong>無追蹤程式碼：')

    content = content.replace("<h2>2. 暫存檔案管理</h2>", '<h2 data-i18n="privacy_h2_2">2. 暫存檔案管理</h2>')
    content = content.replace("<p>當您在", '<p data-i18n="privacy_p2">當您在')
    content = content.replace("<li><strong>記憶體層級處理：", '<li data-i18n="privacy_li_2_1"><strong>記憶體層級處理：')
    content = content.replace("<li><strong>歷史紀錄：", '<li data-i18n="privacy_li_2_2"><strong>歷史紀錄：')

    content = content.replace("<h2>3. 權限需求說明</h2>", '<h2 data-i18n="privacy_h2_3">3. 權限需求說明</h2>')
    content = content.replace("<p>在", '<p data-i18n="privacy_p3">在')
    content = content.replace("<li><strong>本地檔案存取：", '<li data-i18n="privacy_li_3_1"><strong>本地檔案存取：')
    content = content.replace("<li><strong>GPU 加速權限：", '<li data-i18n="privacy_li_3_2"><strong>GPU 加速權限：')

    content = content.replace("<h2>4. 隱私權政策的修訂</h2>", '<h2 data-i18n="privacy_h2_4">4. 隱私權政策的修訂</h2>')
    content = content.replace("<p>本隱私權政策將隨軟體", '<p data-i18n="privacy_p4">本隱私權政策將隨軟體')
    content = content.replace("<p>最後更新日期：", '<p data-i18n="privacy_date">最後更新日期：')
    
    content = content.replace("<p>© 2026 OCREditor v1.0.0. Open sourced under MIT License.</p>", '<p data-i18n="footer_copy">© 2026 OCREditor v1.0.0. Open sourced under MIT License.</p>')
    
    # Add script tag
    content = content.replace("</body>", '    <script src="i18n.js"></script>\n</body>')
    
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)

print("Updated all privacy html files.")
