import os
from flask import Flask, render_template, request, session, redirect, url_for, jsonify
from flask_socketio import SocketIO, emit
from flask_sqlalchemy import SQLAlchemy

app = Flask(__name__)
app.config['SECRET_KEY'] = 'supersecretkey123'

# Use a local sqlite file
db_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'chat.db')
app.config['SQLALCHEMY_DATABASE_URI'] = f'sqlite:///{db_path}'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)
socketio = SocketIO(app, cors_allowed_origins="*")

# Database Models
class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(50), unique=True, nullable=False)
    password = db.Column(db.String(100), nullable=False)

class Friendship(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    friend_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    status = db.Column(db.String(20), default='pending') # pending, accepted

    user = db.relationship("User", foreign_keys=[user_id])
    friend = db.relationship("User", foreign_keys=[friend_id])

class Message(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    sender_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    receiver_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    content = db.Column(db.Text, nullable=False)
    timestamp = db.Column(db.DateTime, server_default=db.func.now())

    sender = db.relationship("User", foreign_keys=[sender_id])
    receiver = db.relationship("User", foreign_keys=[receiver_id])

with app.app_context():
    db.create_all()

# Connected users dict {username: sid}
connected_users = {}

@app.route('/')
def index():
    if 'username' in session:
        return redirect(url_for('chat'))
    return render_template('login.html')

@app.route('/login', methods=['POST'])
def login():
    data = request.json
    username = data.get('username')
    password = data.get('password')
    user = User.query.filter_by(username=username, password=password).first()
    if user:
        session['username'] = user.username
        session['user_id'] = user.id
        return jsonify({"success": True})
    return jsonify({"success": False, "message": "Geçersiz kullanıcı adı veya şifre"}), 401

@app.route('/register', methods=['POST'])
def register():
    data = request.json
    username = data.get('username')
    password = data.get('password')
    if User.query.filter_by(username=username).first():
        return jsonify({"success": False, "message": "Kullanıcı adı zaten alınmış"}), 400
    
    new_user = User(username=username, password=password)
    db.session.add(new_user)
    db.session.commit()
    return jsonify({"success": True})

@app.route('/logout')
def logout():
    session.pop('username', None)
    session.pop('user_id', None)
    return redirect(url_for('index'))

@app.route('/chat')
def chat():
    if 'username' not in session:
        return redirect(url_for('index'))
    return render_template('chat.html', username=session['username'])

@app.route('/api/friends', methods=['GET'])
def get_friends():
    if 'user_id' not in session:
        return jsonify([])
    user_id = session['user_id']
    
    # Get accepted friends
    friends1 = Friendship.query.filter_by(user_id=user_id, status='accepted').all()
    friends2 = Friendship.query.filter_by(friend_id=user_id, status='accepted').all()
    
    friend_list = []
    for f in friends1:
        friend_list.append({"id": f.friend.id, "username": f.friend.username})
    for f in friends2:
        friend_list.append({"id": f.user.id, "username": f.user.username})
        
    return jsonify(friend_list)

@app.route('/api/friend-requests', methods=['GET'])
def get_friend_requests():
    if 'user_id' not in session:
        return jsonify([])
    user_id = session['user_id']
    requests = Friendship.query.filter_by(friend_id=user_id, status='pending').all()
    req_list = [{"id": r.id, "sender": r.user.username} for r in requests]
    return jsonify(req_list)

@app.route('/api/add-friend', methods=['POST'])
def add_friend():
    if 'user_id' not in session:
        return jsonify({"success": False, "message": "Giriş yapmalısınız"}), 401
    
    data = request.json
    friend_username = data.get('username')
    friend = User.query.filter_by(username=friend_username).first()
    
    if not friend:
        return jsonify({"success": False, "message": "Kullanıcı bulunamadı"}), 404
        
    if friend.id == session['user_id']:
        return jsonify({"success": False, "message": "Kendinizi ekleyemezsiniz"}), 400
        
    # Check if already friends or requested
    existing1 = Friendship.query.filter_by(user_id=session['user_id'], friend_id=friend.id).first()
    existing2 = Friendship.query.filter_by(user_id=friend.id, friend_id=session['user_id']).first()
    
    if existing1 or existing2:
        return jsonify({"success": False, "message": "Zaten arkadaşsınız veya istek gönderilmiş"}), 400
        
    new_request = Friendship(user_id=session['user_id'], friend_id=friend.id)
    db.session.add(new_request)
    db.session.commit()
    
    # Notify if the friend is connected
    if friend_username in connected_users:
        socketio.emit('friend_request', {"sender": session['username']}, to=connected_users[friend_username])
        
    return jsonify({"success": True})

@app.route('/api/accept-friend', methods=['POST'])
def accept_friend():
    if 'user_id' not in session:
        return jsonify({"success": False}), 401
        
    data = request.json
    request_id = data.get('request_id')
    
    friend_req = Friendship.query.get(request_id)
    if friend_req and friend_req.friend_id == session['user_id']:
        friend_req.status = 'accepted'
        db.session.commit()
        return jsonify({"success": True})
    return jsonify({"success": False}), 400

@app.route('/api/messages/<int:friend_id>', methods=['GET'])
def get_messages(friend_id):
    if 'user_id' not in session:
        return jsonify([])
    user_id = session['user_id']
    
    messages = Message.query.filter(
        ((Message.sender_id == user_id) & (Message.receiver_id == friend_id)) |
        ((Message.sender_id == friend_id) & (Message.receiver_id == user_id))
    ).order_by(Message.timestamp.asc()).all()
    
    msg_list = []
    for m in messages:
        msg_list.append({
            "id": m.id,
            "sender_id": m.sender_id,
            "content": m.content,
            "timestamp": m.timestamp.strftime("%H:%M")
        })
    return jsonify(msg_list)


# --- Socket.IO Events ---

@socketio.on('connect')
def handle_connect():
    if 'username' in session:
        connected_users[session['username']] = request.sid
        emit('user_connected', {"username": session['username']}, broadcast=True)

@socketio.on('disconnect')
def handle_disconnect():
    if 'username' in session:
        username = session['username']
        if username in connected_users:
            del connected_users[username]
        emit('user_disconnected', {"username": username}, broadcast=True)

@socketio.on('send_message')
def handle_message(data):
    if 'username' not in session:
        return
        
    receiver_username = data.get('receiver')
    content = data.get('content')
    
    receiver = User.query.filter_by(username=receiver_username).first()
    if not receiver:
        return
        
    new_msg = Message(sender_id=session['user_id'], receiver_id=receiver.id, content=content)
    db.session.add(new_msg)
    db.session.commit()
    
    msg_data = {
        "sender": session['username'],
        "content": content,
        "timestamp": new_msg.timestamp.strftime("%H:%M")
    }
    
    # Emit to receiver
    if receiver_username in connected_users:
        emit('receive_message', msg_data, to=connected_users[receiver_username])
        
    # Emit back to sender (for confirmation/display)
    emit('receive_message', msg_data, to=request.sid)

# --- WebRTC Signaling ---
@socketio.on('call-user')
def call_user(data):
    receiver = data['userToCall']
    offer = data['signalData']
    if receiver in connected_users:
        emit('incoming-call', {'from': session['username'], 'signal': offer}, to=connected_users[receiver])

@socketio.on('answer-call')
def answer_call(data):
    caller = data['to']
    answer = data['signal']
    if caller in connected_users:
        emit('call-accepted', answer, to=connected_users[caller])

@socketio.on('ice-candidate')
def handle_ice(data):
    target = data['target']
    candidate = data['candidate']
    if target in connected_users:
        emit('ice-candidate', {'candidate': candidate, 'from': session['username']}, to=connected_users[target])
        
@socketio.on('end-call')
def handle_end_call(data):
    target = data['target']
    if target in connected_users:
        emit('call-ended', {'from': session['username']}, to=connected_users[target])


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, host='0.0.0.0', port=port, debug=False, allow_unsafe_werkzeug=True)
