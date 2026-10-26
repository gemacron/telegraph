import redis
import logging
from collections import defaultdict
from django.conf import settings

logger = logging.getLogger(__name__)

class PresenceService:
    """
    Servicio de presencia en tiempo real con Redis y fallback en memoria.
    Rastrea sockets activos por usuario para determinar si está 'online' u 'offline'.
    """
    REDIS_ONLINE_KEY = "telegraph:presence:online_users"
    REDIS_SOCKET_PREFIX = "telegraph:presence:user_sockets:"

    _in_memory_sockets = defaultdict(set)

    @classmethod
    def _get_redis(cls):
        if getattr(settings, 'CHANNEL_BACKEND', '') == 'redis':
            try:
                return redis.Redis(
                    host=getattr(settings, 'REDIS_HOST', 'localhost'),
                    port=int(getattr(settings, 'REDIS_PORT', 6379)),
                    db=1,
                    decode_responses=True,
                    socket_connect_timeout=2
                )
            except Exception as e:
                logger.warning(f"No se pudo conectar a Redis para presencia: {e}")
                return None
        return None

    @classmethod
    def add_connection(cls, user_id: int, channel_name: str) -> bool:
        """
        Registra una conexión activa de WebSocket para el usuario.
        Retorna True si el usuario estaba offline antes de esta conexión (acaba de pasar a online).
        """
        user_id_str = str(user_id)
        r = cls._get_redis()
        if r:
            try:
                socket_key = f"{cls.REDIS_SOCKET_PREFIX}{user_id_str}"
                prev_count = r.scard(socket_key)
                r.sadd(socket_key, channel_name)
                r.expire(socket_key, 86400)
                r.sadd(cls.REDIS_ONLINE_KEY, user_id_str)
                return prev_count == 0
            except Exception as e:
                logger.error(f"Error registrando conexión en Redis: {e}")

        prev_count = len(cls._in_memory_sockets[user_id_str])
        cls._in_memory_sockets[user_id_str].add(channel_name)
        return prev_count == 0

    @classmethod
    def remove_connection(cls, user_id: int, channel_name: str) -> bool:
        """
        Remueve una conexión activa de WebSocket para el usuario.
        Retorna True si ya no le quedan conexiones activas (acaba de pasar a offline).
        """
        user_id_str = str(user_id)
        r = cls._get_redis()
        if r:
            try:
                socket_key = f"{cls.REDIS_SOCKET_PREFIX}{user_id_str}"
                r.srem(socket_key, channel_name)
                remaining = r.scard(socket_key)
                if remaining == 0:
                    r.srem(cls.REDIS_ONLINE_KEY, user_id_str)
                    r.delete(socket_key)
                    return True
                return False
            except Exception as e:
                logger.error(f"Error removiendo conexión en Redis: {e}")

        if user_id_str in cls._in_memory_sockets:
            cls._in_memory_sockets[user_id_str].discard(channel_name)
            if len(cls._in_memory_sockets[user_id_str]) == 0:
                del cls._in_memory_sockets[user_id_str]
                return True
        return False

    @classmethod
    def force_offline(cls, user_id: int) -> bool:
        """Fuerza al usuario a offline (p. ej. al hacer logout)."""
        user_id_str = str(user_id)
        r = cls._get_redis()
        if r:
            try:
                r.srem(cls.REDIS_ONLINE_KEY, user_id_str)
                r.delete(f"{cls.REDIS_SOCKET_PREFIX}{user_id_str}")
                return True
            except Exception as e:
                logger.error(f"Error forzando offline en Redis: {e}")

        cls._in_memory_sockets.pop(user_id_str, None)
        return True

    @classmethod
    def get_online_user_ids(cls) -> set:
        """Retorna un set con los IDs de usuario (enteros) actualmente en línea."""
        r = cls._get_redis()
        if r:
            try:
                members = r.smembers(cls.REDIS_ONLINE_KEY)
                return {int(uid) for uid in members if uid.isdigit()}
            except Exception as e:
                logger.error(f"Error obteniendo usuarios en línea de Redis: {e}")

        return {int(uid) for uid, sockets in cls._in_memory_sockets.items() if sockets and uid.isdigit()}

    @classmethod
    def is_user_online(cls, user_id: int) -> bool:
        user_id_str = str(user_id)
        r = cls._get_redis()
        if r:
            try:
                return bool(r.sismember(cls.REDIS_ONLINE_KEY, user_id_str))
            except Exception as e:
                logger.error(f"Error verificando usuario online en Redis: {e}")

        return bool(cls._in_memory_sockets.get(user_id_str))

    REDIS_STATUS_PREFIX = "telegraph:presence:user_status:"
    _in_memory_status = {}

    @classmethod
    def set_user_status(cls, user_id: int, status: str):
        """Guarda el estado de disponibilidad ('online', 'idle', 'dnd', 'offline')."""
        user_id_str = str(user_id)
        if status not in ['online', 'idle', 'dnd', 'offline']:
            status = 'online'
        r = cls._get_redis()
        if r:
            try:
                r.set(f"{cls.REDIS_STATUS_PREFIX}{user_id_str}", status, ex=86400 * 7)
            except Exception as e:
                logger.error(f"Error guardando status en Redis: {e}")
        cls._in_memory_status[user_id_str] = status

    @classmethod
    def get_user_status(cls, user_id: int, is_connected=None) -> str:
        """
        Retorna el estado efectivo del usuario:
        Si no está conectado o su estado es 'offline', retorna 'offline'.
        De lo contrario retorna 'online', 'idle' o 'dnd'.
        """
        user_id_str = str(user_id)
        if is_connected is None:
            is_connected = cls.is_user_online(user_id)
        if not is_connected:
            return 'offline'

        r = cls._get_redis()
        if r:
            try:
                val = r.get(f"{cls.REDIS_STATUS_PREFIX}{user_id_str}")
                if val in ['online', 'idle', 'dnd', 'offline']:
                    return val
            except Exception as e:
                logger.error(f"Error obteniendo status de Redis: {e}")

        return cls._in_memory_status.get(user_id_str, 'online')

    @classmethod
    def get_all_user_statuses(cls, online_ids=None) -> dict:
        """Retorna un dict {user_id: status} para todos los usuarios en línea."""
        if online_ids is None:
            online_ids = cls.get_online_user_ids()
        res = {}
        for uid in online_ids:
            res[uid] = cls.get_user_status(uid, is_connected=True)
        return res

