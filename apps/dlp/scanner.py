import re
from typing import Dict, List, Any

class DataLossPreventionScanner:
    """
    Motor determinista de inspección de contenido (DLP) para programadores.
    Previene la fuga accidental de credenciales, claves de API y secretos.
    Funciona 100% local sin dependencias externas usando regex compilados.
    """
    PATTERNS: Dict[str, Dict[str, Any]] = {
        "SSH_PRIVATE_KEY": {
            "regex": re.compile(r"-----BEGIN (?:RSA|OPENSSH|DSA|EC|PGP) PRIVATE KEY-----"),
            "label": "Clave Privada Criptográfica (SSH / RSA / PGP)",
            "severity": "CRITICAL"
        },
        "AWS_KEY_ID": {
            "regex": re.compile(r"(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}"),
            "label": "Access Key ID de AWS",
            "severity": "HIGH"
        },
        "GITHUB_TOKEN": {
            "regex": re.compile(r"(?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9_]{36,255}"),
            "label": "Personal Access Token de GitHub",
            "severity": "CRITICAL"
        },
        "DATABASE_URI_PASSWORD": {
            "regex": re.compile(r"(?:postgres|postgresql|mysql|mongodb|redis)://[^:]+:([^@]+)@"),
            "label": "Cadena de Conexión a Base de Datos con Contraseña",
            "severity": "CRITICAL"
        },
        "GENERIC_PASSWORD_ASSIGNMENT": {
            "regex": re.compile(
                r"(?:password|passwd|pwd|db_pass|secret_key|api_key|auth_token)\s*[:=]\s*['\"][A-Za-z0-9_\-\.\$\!\#\%\&\*\@]{6,}['\"]", 
                re.IGNORECASE
            ),
            "label": "Asignación explícita de Contraseña o Llave Secreta",
            "severity": "HIGH"
        },
        "API_PROVIDER_TOKENS": {
            "regex": re.compile(
                r"(?:sk-[a-zA-Z0-9]{32,}|xox[baprs]-[0-9a-zA-Z]{10,48}|SG\.[a-zA-Z0-9_\-]{22}\.[a-zA-Z0-9_\-]{43}|hf_[a-zA-Z0-9]{34})",
            ),
            "label": "Token de API Comercial (OpenAI, Slack, SendGrid, HuggingFace)",
            "severity": "CRITICAL"
        },
        "JWT_TOKEN": {
            "regex": re.compile(r"eyJ[A-Za-z0-9-_=]{15,}\.eyJ[A-Za-z0-9-_=]{15,}\.[A-Za-z0-9-_.+/=]{15,}"),
            "label": "Token de Autenticación JWT",
            "severity": "MEDIUM"
        },
    }

    @classmethod
    def scan(cls, content: str) -> Dict[str, Any]:
        """
        Analiza el contenido antes de permitir su persistencia o emisión.
        Retorna is_safe: False si contiene datos prohibidos.
        """
        if not content:
            return {"is_safe": True, "violations": []}

        violations: List[Dict[str, str]] = []
        for rule_key, rule_data in cls.PATTERNS.items():
            if rule_data["regex"].search(content):
                violations.append({
                    "rule": rule_key,
                    "label": rule_data["label"],
                    "severity": rule_data["severity"]
                })

        return {
            "is_safe": len(violations) == 0,
            "violations": violations
        }

