import os
import secrets
from datetime import datetime, timedelta, timezone
from functools import wraps

from flask import Flask, jsonify, redirect, render_template, request, session, url_for, abort
from flask_sqlalchemy import SQLAlchemy
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "change-this-development-secret")
database_url = os.environ.get("DATABASE_URL", "sqlite:///locatehub.db")
for prefix in ("postgres://", "postgresql://"):          # use the psycopg 3 driver from requirements.txt
    if database_url.startswith(prefix):
        database_url = "postgresql+psycopg://" + database_url[len(prefix):]
        break
app.config["SQLALCHEMY_DATABASE_URI"] = database_url
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
db = SQLAlchemy(app)

DASHBOARD_PASSWORD = os.environ.get("LOCATEHUB_PASSWORD", "ChangeMe-123!")
INVITE_HOURS = int(os.environ.get("INVITE_HOURS", "24"))
RETENTION_DAYS = int(os.environ.get("RETENTION_DAYS", "30"))   # location history older than this is deleted
DEBUG = os.environ.get("FLASK_DEBUG") == "1"
LOGIN_FAILS = {}
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)   # correct https links behind Render
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax",
                  SESSION_COOKIE_SECURE=bool(os.environ.get("RENDER") or os.environ.get("COOKIE_SECURE") == "1"))
if not DEBUG and (app.config["SECRET_KEY"] == "change-this-development-secret" or (
        DASHBOARD_PASSWORD == "ChangeMe-123!" and not os.environ.get("LOCATEHUB_PASSWORD_HASH"))):
    raise SystemExit("Set SECRET_KEY and LOCATEHUB_PASSWORD (or use FLASK_DEBUG=1 for local testing only).")


def utcnow():
    return datetime.now(timezone.utc)


class Invitation(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    token = db.Column(db.String(80), unique=True, nullable=False, index=True)
    label = db.Column(db.String(100), nullable=False, default="Phone")
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    expires_at = db.Column(db.DateTime(timezone=True), nullable=False)
    active = db.Column(db.Boolean, nullable=False, default=True)
    consented_at = db.Column(db.DateTime(timezone=True), nullable=True)
    sharing = db.Column(db.Boolean, nullable=False, default=False)
    last_lat = db.Column(db.Float, nullable=True)
    last_lng = db.Column(db.Float, nullable=True)
    last_accuracy = db.Column(db.Float, nullable=True)
    last_seen = db.Column(db.DateTime(timezone=True), nullable=True)
    last_speed = db.Column(db.Float, nullable=True)
    last_heading = db.Column(db.Float, nullable=True)
    history = db.relationship("LocationPoint", backref="invitation", lazy=True,
                               cascade="all, delete-orphan")


class LocationPoint(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    invitation_id = db.Column(db.Integer, db.ForeignKey("invitation.id"), nullable=False, index=True)
    lat = db.Column(db.Float, nullable=False)
    lng = db.Column(db.Float, nullable=False)
    accuracy = db.Column(db.Float, nullable=True)
    speed = db.Column(db.Float, nullable=True)
    heading = db.Column(db.Float, nullable=True)
    recorded_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)


def dashboard_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("dashboard_authenticated"):
            return redirect(url_for("login", next=request.path))
        return fn(*args, **kwargs)
    return wrapper


def aware(value):
    return value if value is None or value.tzinfo else value.replace(tzinfo=timezone.utc)


def as_iso(value):
    if not value:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


@app.route("/")
def index():
    if session.get("dashboard_authenticated"):
        return redirect(url_for("dashboard"))
    return redirect(url_for("login"))


@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        ip = request.remote_addr or "?"
        now_ts = utcnow().timestamp()
        recent = [t for t in LOGIN_FAILS.get(ip, []) if now_ts - t < 600]
        if len(recent) >= 5:
            return render_template("login.html", error="Too many attempts. Try again in 10 minutes."), 429
        password = request.form.get("password", "")
        # Supports a hashed password if LOCATEHUB_PASSWORD_HASH is configured.
        password_hash = os.environ.get("LOCATEHUB_PASSWORD_HASH")
        valid = check_password_hash(password_hash, password) if password_hash else secrets.compare_digest(password, DASHBOARD_PASSWORD)
        if valid:
            session.clear()
            session["dashboard_authenticated"] = True
            return redirect(url_for("dashboard"))
        LOGIN_FAILS[ip] = recent + [now_ts]
        error = "Incorrect password. Try again."
    return render_template("login.html", error=error)


@app.route("/logout", methods=["POST"])
@dashboard_required
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/dashboard")
@dashboard_required
def dashboard():
    invitations = Invitation.query.order_by(Invitation.created_at.desc()).all()
    return render_template("dashboard.html", invitations=invitations, invite_hours=INVITE_HOURS)


@app.route("/api/invitations", methods=["POST"])
@dashboard_required
def create_invitation():
    body = request.get_json(silent=True) or {}
    label = str(body.get("label", "Phone")).strip()[:100] or "Phone"
    token = secrets.token_urlsafe(24)
    invite = Invitation(
        token=token,
        label=label,
        created_at=utcnow(),
        expires_at=utcnow() + timedelta(hours=INVITE_HOURS),
        active=True,
    )
    db.session.add(invite)
    db.session.commit()
    return jsonify({"id": invite.id, "label": invite.label,
                    "url": url_for("share_page", token=token, _external=True),
                    "expires_at": as_iso(invite.expires_at)}), 201


@app.route("/api/invitations/<int:invite_id>/revoke", methods=["POST"])
@dashboard_required
def revoke_invitation(invite_id):
    invite = db.get_or_404(Invitation, invite_id)
    invite.active = False
    invite.sharing = False
    db.session.commit()
    return jsonify({"ok": True})


@app.route("/api/locations")
@dashboard_required
def locations():
    now = utcnow()
    results = []
    for invite in Invitation.query.order_by(Invitation.created_at.desc()).all():
        results.append({
            "id": invite.id,
            "label": invite.label,
            "active": invite.active and aware(invite.expires_at) > now,
            "sharing": invite.sharing and invite.active and aware(invite.expires_at) > now,
            "consented": invite.consented_at is not None,
            "lat": invite.last_lat,
            "lng": invite.last_lng,
            "accuracy": invite.last_accuracy,
            "speed": invite.last_speed,
            "heading": invite.last_heading,
            "last_seen": as_iso(invite.last_seen),
            "expires_at": as_iso(invite.expires_at),
            "share_url": url_for("share_page", token=invite.token, _external=True),
        })
    return jsonify(results)


@app.route("/api/locations/<int:invite_id>/history")
@dashboard_required
def location_history(invite_id):
    invite = db.get_or_404(Invitation, invite_id)
    points = (LocationPoint.query.filter_by(invitation_id=invite.id)
              .order_by(LocationPoint.recorded_at.desc()).limit(500).all())
    points.reverse()
    return jsonify([{"lat": p.lat, "lng": p.lng, "accuracy": p.accuracy, "speed": p.speed,
                     "recorded_at": as_iso(p.recorded_at)} for p in points])


@app.route("/share/<token>")
def share_page(token):
    invite = Invitation.query.filter_by(token=token).first_or_404()
    expired = aware(invite.expires_at) <= utcnow()
    if not invite.active or expired:
        return render_template("share.html", invite=invite, unavailable=True)
    return render_template("share.html", invite=invite, unavailable=False)


@app.route("/api/share/<token>/status")
def share_status(token):
    invite = Invitation.query.filter_by(token=token).first_or_404()
    if not invite.active or aware(invite.expires_at) <= utcnow():
        return jsonify({"ok": False, "message": "This invitation has expired or been revoked."}), 410
    return jsonify({"ok": True, "sharing": invite.sharing})


@app.route("/api/share/<token>/start", methods=["POST"])
def start_sharing(token):
    invite = Invitation.query.filter_by(token=token).first_or_404()
    if not invite.active or aware(invite.expires_at) <= utcnow():
        return jsonify({"ok": False, "message": "This invitation has expired or been revoked."}), 410
    body = request.get_json(silent=True) or {}
    if body.get("consent") is not True:
        return jsonify({"ok": False, "message": "Consent is required before sharing."}), 400
    invite.consented_at = utcnow()
    invite.sharing = True
    db.session.commit()
    return jsonify({"ok": True})


def _num(v, lo, hi, default=None):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return default
    return v if lo <= v <= hi else default


@app.route("/api/share/<token>/location", methods=["POST"])
def receive_location(token):
    invite = Invitation.query.filter_by(token=token).first_or_404()
    if not invite.active or aware(invite.expires_at) <= utcnow():
        return jsonify({"ok": False, "message": "This invitation has expired or been revoked."}), 410
    if not invite.sharing or not invite.consented_at:
        return jsonify({"ok": False, "message": "Location sharing has not been started with consent."}), 403
    body = request.get_json(silent=True) or {}
    items = body.get("points") if isinstance(body.get("points"), list) else [body]   # batches resend offline points
    now, saved = utcnow(), 0
    for p in items[:200]:
        if not isinstance(p, dict):
            continue
        lat, lng = _num(p.get("lat"), -90, 90), _num(p.get("lng"), -180, 180)
        if lat is None or lng is None:
            continue
        when, ms = now, _num(p.get("t"), 1, 4e12)
        if ms:
            client_time = datetime.fromtimestamp(ms / 1000, timezone.utc)
            if now - timedelta(hours=24) <= client_time <= now + timedelta(minutes=1):
                when = client_time
        acc = _num(p.get("accuracy"), 0, 100000, 0)
        speed, heading = _num(p.get("speed"), 0, 400), _num(p.get("heading"), 0, 360)
        db.session.add(LocationPoint(invitation_id=invite.id, lat=lat, lng=lng, accuracy=acc,
                                     speed=speed, heading=heading, recorded_at=when))
        if not invite.last_seen or when >= aware(invite.last_seen):
            invite.last_lat, invite.last_lng, invite.last_accuracy = lat, lng, acc
            invite.last_speed, invite.last_heading, invite.last_seen = speed, heading, when
        saved += 1
    if not saved:
        return jsonify({"ok": False, "message": "Invalid GPS coordinates."}), 400
    db.session.commit()
    return jsonify({"ok": True, "saved": saved})


@app.route("/api/share/<token>/stop", methods=["POST"])
def stop_sharing(token):
    invite = Invitation.query.filter_by(token=token).first_or_404()
    invite.sharing = False
    db.session.commit()
    return jsonify({"ok": True})


@app.route("/api/locations/<int:invite_id>/clear", methods=["POST"])
@dashboard_required
def clear_history(invite_id):
    invite = db.get_or_404(Invitation, invite_id)
    LocationPoint.query.filter_by(invitation_id=invite.id).delete()
    invite.last_lat = invite.last_lng = invite.last_accuracy = None
    invite.last_speed = invite.last_heading = invite.last_seen = None
    db.session.commit()
    return jsonify({"ok": True})


def purge_old():
    cutoff = utcnow() - timedelta(days=RETENTION_DAYS)
    LocationPoint.query.filter(LocationPoint.recorded_at < cutoff).delete()
    db.session.commit()


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


with app.app_context():
    try:
        db.create_all()
        purge_old()
    except Exception as exc:      # another worker may be creating the tables at the same moment
        db.session.rollback()
        print("Startup DB note:", exc)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), debug=DEBUG)
