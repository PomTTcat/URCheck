import json
import smtplib
from email.message import EmailMessage
from pathlib import Path


CONFIG_FILE = Path(__file__).with_name("email_config.json")


def load_config() -> dict:
    if not CONFIG_FILE.exists():
        raise RuntimeError(f"Email config file not found: {CONFIG_FILE}")

    config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    config.setdefault("smtp_host", "smtp.gmail.com")
    config.setdefault("smtp_port", 587)
    config.setdefault("use_tls", True)
    config.setdefault("mail_from", config.get("smtp_username", ""))
    config.setdefault("mail_to_alert", config.get("mail_to", ""))
    config.setdefault("mail_to_heartbeat", config.get("mail_to", ""))
    return config


def send_change_email(
    message_body: str,
    subject: str | None = None,
    mail_to: str | list[str] | None = None,
) -> None:
    config = load_config()
    recipients = mail_to or config.get("mail_to_alert") or config.get("mail_to")
    required_keys = ["smtp_host", "smtp_username", "smtp_password", "mail_from"]
    missing_keys = [key for key in required_keys if not config.get(key)]
    if not recipients:
        missing_keys.append("mail_to")
    if missing_keys:
        raise RuntimeError(f"Email config is missing: {', '.join(missing_keys)}")

    message = EmailMessage()
    message["Subject"] = subject or config.get("subject", "UR room list changed")
    message["From"] = config["mail_from"]
    message["To"] = recipients if isinstance(recipients, str) else ", ".join(recipients)
    message.set_content(message_body)

    with smtplib.SMTP(config["smtp_host"], int(config["smtp_port"]), timeout=30) as smtp:
        if config.get("use_tls", True):
            smtp.starttls()
        smtp.login(config["smtp_username"], config["smtp_password"])
        smtp.send_message(message)


if __name__ == "__main__":
    send_change_email("This is a test email from the UR room monitor.")
    print("Test email sent.")
