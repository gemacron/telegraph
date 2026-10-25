import json
from django.test import TestCase, Client
from django.contrib.auth.models import User
from apps.chat.models import Workspace, Channel, UserProfile

class WhatsAppStyleChannelTests(TestCase):
    def setUp(self):
        # Create workspace
        self.workspace = Workspace.objects.create(name="Telegraph HQ", slug="telegraph-hq")

        # Create Admin
        self.admin_user = User.objects.create_user(username="admin_user", password="Password123!")
        self.admin_user.profile.role = 'admin'
        self.admin_user.profile.save()

        # Create Manager User (Encargado)
        self.manager_user = User.objects.create_user(username="encargado_user", password="Password123!")
        self.manager_user.profile.role = 'member'
        self.manager_user.profile.save()

        # Create Normal Member User
        self.member_user = User.objects.create_user(username="member_user", password="Password123!")
        self.member_user.profile.role = 'member'
        self.member_user.profile.save()

        # Create Outsider User (not in private channel)
        self.outsider_user = User.objects.create_user(username="outsider_user", password="Password123!")
        self.outsider_user.profile.role = 'member'
        self.outsider_user.profile.save()

        # Create General Channel (accessible to everyone)
        self.general_channel = Channel.objects.create(
            workspace=self.workspace,
            name="general",
            is_general=True,
            created_by=self.admin_user
        )

        # Create Private Channel (WhatsApp group style)
        self.secret_channel = Channel.objects.create(
            workspace=self.workspace,
            name="dev-team-private",
            is_general=False,
            is_private=True,
            created_by=self.admin_user
        )
        self.secret_channel.managers.add(self.manager_user)
        self.secret_channel.members.add(self.manager_user, self.member_user)

        # Create Public Channel (All workspace members assigned)
        self.public_channel = Channel.objects.create(
            workspace=self.workspace,
            name="public-discussion",
            is_general=False,
            is_private=False,
            created_by=self.admin_user
        )
        self.public_channel.members.add(self.admin_user, self.manager_user, self.member_user, self.outsider_user)

    def test_channel_visibility(self):
        """Outsider should not see private channel, but can see public channel"""
        self.assertTrue(self.secret_channel.can_view(self.manager_user))
        self.assertTrue(self.secret_channel.can_view(self.member_user))
        self.assertFalse(self.secret_channel.can_view(self.outsider_user))
        # Public channel is visible to outsider
        self.assertTrue(self.public_channel.can_view(self.outsider_user))

        # Outsider client
        client = Client()
        client.login(username="outsider_user", password="Password123!")

        # Request secret channel directly: should redirect to first accessible channel, never 403
        response = client.get(f'/channels/{self.secret_channel.id}/', follow=True)
        self.assertEqual(response.status_code, 200)
        # Verify rendered channel in context is general_channel
        self.assertEqual(response.context['active_channel'].id, self.general_channel.id)

        # Verify sidebar channel list only contains general
        channels_in_sidebar = list(response.context['channels'])
        self.assertIn(self.general_channel, channels_in_sidebar)
        self.assertIn(self.public_channel, channels_in_sidebar)
        self.assertNotIn(self.secret_channel, channels_in_sidebar)

    def test_manager_permissions(self):
        """Encargado (Manager) can manage channel, but standard member cannot"""
        self.assertTrue(self.secret_channel.can_manage(self.manager_user))
        self.assertFalse(self.secret_channel.can_manage(self.member_user))
        self.assertFalse(self.secret_channel.can_manage(self.outsider_user))
        # Admin can manage as well
        self.assertTrue(self.secret_channel.can_manage(self.admin_user))

    def test_manager_can_add_and_remove_member(self):
        """Encargado adds outsider, verifies access, then removes outsider"""
        client = Client()
        client.login(username="encargado_user", password="Password123!")

        # Add outsider
        add_res = client.post(
            f'/api/channels/{self.secret_channel.id}/manage/',
            data=json.dumps({'action': 'add_member', 'user_id': self.outsider_user.id}),
            content_type='application/json'
        )
        self.assertEqual(add_res.status_code, 200)
        self.assertTrue(self.secret_channel.members.filter(id=self.outsider_user.id).exists())
        self.assertTrue(self.secret_channel.can_view(self.outsider_user))

        # Remove outsider
        rem_res = client.post(
            f'/api/channels/{self.secret_channel.id}/manage/',
            data=json.dumps({'action': 'remove_member', 'user_id': self.outsider_user.id}),
            content_type='application/json'
        )
        self.assertEqual(rem_res.status_code, 200)
        self.assertFalse(self.secret_channel.members.filter(id=self.outsider_user.id).exists())
        self.assertFalse(self.secret_channel.can_view(self.outsider_user))

    def test_manager_toggle_manager_status(self):
        """Encargado can promote member to co-manager and demote back"""
        client = Client()
        client.login(username="encargado_user", password="Password123!")

        # Promote member_user to manager
        toggle_res = client.post(
            f'/api/channels/{self.secret_channel.id}/manage/',
            data=json.dumps({'action': 'toggle_manager', 'user_id': self.member_user.id}),
            content_type='application/json'
        )
        self.assertEqual(toggle_res.status_code, 200)
        self.assertTrue(self.secret_channel.managers.filter(id=self.member_user.id).exists())

        # Demote back
        toggle_res2 = client.post(
            f'/api/channels/{self.secret_channel.id}/manage/',
            data=json.dumps({'action': 'toggle_manager', 'user_id': self.member_user.id}),
            content_type='application/json'
        )
        self.assertEqual(toggle_res2.status_code, 200)
        self.assertFalse(self.secret_channel.managers.filter(id=self.member_user.id).exists())

    def test_non_manager_cannot_modify_channel(self):
        """Regular member receives 403 on API modification attempt"""
        client = Client()
        client.login(username="member_user", password="Password123!")

        res = client.post(
            f'/api/channels/{self.secret_channel.id}/manage/',
            data=json.dumps({'action': 'add_member', 'user_id': self.outsider_user.id}),
            content_type='application/json'
        )
        self.assertEqual(res.status_code, 403)

    def test_admin_create_channel_api(self):
        """Workspace Admin can create a new channel and designate manager and initial members"""
        client = Client()
        client.login(username="admin_user", password="Password123!")

        res = client.post(
            '/api/channels/create/',
            data=json.dumps({
                'name': 'security-ops',
                'topic': 'Operaciones de Seguridad',
                'manager_id': self.manager_user.id,
                'member_ids': [self.manager_user.id, self.member_user.id]
            }),
            content_type='application/json'
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data['status'], 'success')

        new_chan = Channel.objects.get(name='security-ops')
        self.assertIn(self.manager_user, new_chan.managers.all())
        self.assertIn(self.member_user, new_chan.members.all())
        self.assertNotIn(self.outsider_user, new_chan.members.all())
