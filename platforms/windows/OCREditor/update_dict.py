import re

path = "/Users/barretlin/GitProjects/OCR/platforms/windows/OCREditor/LocalizationManager.cs"
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

translations = {
    "English": {"ForceComputerFont": "Force Local Fonts after OCR", "PrimaryDefaultFont": "Primary OCR Font (CJK)", "SecondaryDefaultFont": "Secondary OCR Font (Latin)"},
    "繁體中文": {"ForceComputerFont": "OCR後強制套用電腦字型", "PrimaryDefaultFont": "主要預設字型 (中日韓)", "SecondaryDefaultFont": "次要預設字型 (英數)"},
    "简体中文": {"ForceComputerFont": "OCR后强制应用电脑字体", "PrimaryDefaultFont": "主要默认字体 (中日韩)", "SecondaryDefaultFont": "次要默认字体 (英数)"},
    "日本語": {"ForceComputerFont": "OCR後にローカルフォントを強制適用", "PrimaryDefaultFont": "プライマリOCRフォント (CJK)", "SecondaryDefaultFont": "セカンダリOCRフォント (英数)"},
    "한국어": {"ForceComputerFont": "OCR 후 로컬 글꼴 강제 적용", "PrimaryDefaultFont": "기본 OCR 글꼴 (CJK)", "SecondaryDefaultFont": "보조 OCR 글꼴 (영숫자)"},
    "ไทย": {"ForceComputerFont": "บังคับใช้ฟอนต์ในเครื่องหลัง OCR", "PrimaryDefaultFont": "ฟอนต์หลัก OCR", "SecondaryDefaultFont": "ฟอนต์รอง OCR (ภาษาอังกฤษ)"},
    "Español": {"ForceComputerFont": "Forzar fuentes locales tras OCR", "PrimaryDefaultFont": "Fuente OCR primaria", "SecondaryDefaultFont": "Fuente OCR secundaria (Inglés)"},
    "Português": {"ForceComputerFont": "Forçar fontes locais após OCR", "PrimaryDefaultFont": "Fonte OCR primária", "SecondaryDefaultFont": "Fonte OCR secundária (Inglês)"},
    "Bahasa Melayu": {"ForceComputerFont": "Paksa fon tempatan selepas OCR", "PrimaryDefaultFont": "Fon OCR Utama", "SecondaryDefaultFont": "Fon OCR Sekunder (Inggeris)"},
    "Русский": {"ForceComputerFont": "Принудительно локальные шрифты", "PrimaryDefaultFont": "Основной шрифт OCR", "SecondaryDefaultFont": "Дополнительный шрифт OCR (Англ)"},
    "Deutsch": {"ForceComputerFont": "Lokale Schriftarten erzwingen", "PrimaryDefaultFont": "Primäre OCR-Schriftart", "SecondaryDefaultFont": "Sekundäre OCR-Schriftart (Englisch)"}
}

for lang, trans in translations.items():
    # find exactly: "{lang}", new Dictionary<string, string>\n                {
    pattern = r'("' + lang + r'", new Dictionary<string, string>\s*\{\s*)'
    replacement = r'\g<1>' + f'{{ "ForceComputerFont", "{trans["ForceComputerFont"]}" }},\n                    {{ "PrimaryDefaultFont", "{trans["PrimaryDefaultFont"]}" }},\n                    {{ "SecondaryDefaultFont", "{trans["SecondaryDefaultFont"]}" }},\n                    '
    content = re.sub(pattern, replacement, content, count=1)

with open(path, "w", encoding="utf-8") as f:
    f.write(content)
