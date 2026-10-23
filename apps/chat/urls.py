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
    path('login/', views.login_view, name='login'),
    path('register/', views.register_view, name='register'),
    path('logout/', views.logout_view, name='logout'),
]
