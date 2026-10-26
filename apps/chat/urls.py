from django.urls import path
from apps.chat import views

urlpatterns = [
    path('', views.index_view, name='index'),
    path('channels/<uuid:channel_id>/', views.channel_view, name='channel_view'),
    path('dms/<uuid:conversation_id>/', views.dm_view, name='dm_view'),
    path('dms/start/', views.start_dm_view, name='start_dm'),
    path('api/secrets/create/', views.create_ephemeral_secret_api, name='create_ephemeral_secret'),
    path('api/secrets/<uuid:secret_id>/reveal/', views.reveal_ephemeral_secret_api, name='reveal_ephemeral_secret'),
    path('api/attachments/upload/', views.upload_attachment_api, name='upload_attachment'),
    path('profile/update/', views.update_profile_view, name='update_profile'),
    path('api/presence/status/', views.set_presence_status_api, name='set_presence_status_api'),
    path('api/users/<str:username>/profile/', views.get_user_profile_api, name='get_user_profile'),
    path('api/stickers/', views.list_stickers_api, name='list_stickers'),
    path('api/stickers/upload/', views.upload_sticker_api, name='upload_sticker'),
    path('api/gifs/trending/', views.list_trending_gifs_api, name='list_trending_gifs_api'),
    path('api/gifs/search/', views.search_gifs_api, name='search_gifs_api'),
    path('api/channels/create/', views.create_channel_api, name='create_channel_api'),
    path('api/channels/<uuid:channel_id>/manage/', views.manage_channel_api, name='manage_channel_api'),
    path('api/workspace/users/', views.get_workspace_users_api, name='get_workspace_users_api'),
    path('login/', views.login_view, name='login'),
    path('login/2fa/', views.login_2fa_view, name='login_2fa'),
    path('register/', views.register_view, name='register'),
    path('register/2fa/', views.register_2fa_view, name='register_2fa'),
    path('logout/', views.logout_view, name='logout'),
    path('profile/2fa/setup/', views.setup_2fa_view, name='setup_2fa'),
    path('profile/2fa/disable/', views.disable_2fa_view, name='disable_2fa'),
]
