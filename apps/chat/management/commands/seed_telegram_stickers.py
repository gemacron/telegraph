import os
import json
import gzip
import urllib.request
import urllib.parse
from django.core.management.base import BaseCommand
from django.core.files.base import ContentFile
from apps.chat.models import Sticker

class Command(BaseCommand):
    help = 'Puebla la base de datos con los paquetes de stickers oficiales y animados de Telegram'

    def handle(self, *args, **options):
        self.stdout.write(self.style.NOTICE("Iniciando descarga y configuración de stickers oficiales de Telegram..."))

        # Limpiar stickers viejos de prueba con nombres genéricos
        Sticker.objects.filter(name__in=[
            'lgtm', 'works_on_my_machine', 'deploy_friday', 'python_power', 
            'bug_hunter', 'coffee_code', 'docker_ship', 'dlp_safe'
        ]).delete()

        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}

        # 1. Pack: Telegram Animados Oficial (.TGS Lottie de DrKLO / Telegram Official)
        tgs_stickers = [
            ("a_sticker1.tgs", "Telegram Party Star", "Telegram Animados Oficial"),
            ("a_sticker2.tgs", "Telegram Heart Love", "Telegram Animados Oficial"),
            ("a_sticker3.tgs", "Telegram High Five", "Telegram Animados Oficial"),
            ("a_sticker4.tgs", "Telegram Cool Shades", "Telegram Animados Oficial"),
            ("a_sticker5.tgs", "Telegram Wow Shock", "Telegram Animados Oficial"),
            ("a_sticker6.tgs", "Telegram Wink Smile", "Telegram Animados Oficial"),
            ("a_sticker7.tgs", "Telegram Thumbs Up", "Telegram Animados Oficial"),
            ("a_sticker8.tgs", "Telegram Fire Energy", "Telegram Animados Oficial"),
            ("a_sticker9.tgs", "Telegram Laughing", "Telegram Animados Oficial"),
        ]

        tgs_base_url = "https://raw.githubusercontent.com/DrKLO/TelegramStickersImport/master/app/src/main/res/raw/"

        for filename, sticker_name, category in tgs_stickers:
            try:
                url = tgs_base_url + filename
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=10) as response:
                    raw_data = response.read()
                    try:
                        decompressed = gzip.decompress(raw_data).decode('utf-8')
                    except Exception:
                        decompressed = ""

                    sticker, created = Sticker.objects.update_or_create(
                        name=sticker_name,
                        category=category,
                        defaults={
                            'is_animated': True,
                            'animation_type': 'tgs',
                            'lottie_json': decompressed
                        }
                    )
                    sticker.image.save(filename, ContentFile(raw_data), save=True)
                    self.stdout.write(self.style.SUCCESS(f" [OK] {category} -> {sticker_name}"))
            except Exception as e:
                self.stdout.write(self.style.WARNING(f" [ERR] {sticker_name}: {e}"))

        # 2. Pack: Telegram Clásicos Oficiales (.WEBP de Telegram)
        webp_stickers = [
            ("sticker1.webp", "Telegram Star", "Telegram Clásicos"),
            ("sticker2.webp", "Telegram Big Heart", "Telegram Clásicos"),
            ("sticker3.webp", "Telegram Hands", "Telegram Clásicos"),
            ("sticker4.webp", "Telegram Sunglasses", "Telegram Clásicos"),
            ("sticker5.webp", "Telegram Surprised", "Telegram Clásicos"),
            ("sticker6.webp", "Telegram Friendly", "Telegram Clásicos"),
            ("sticker7.webp", "Telegram Like", "Telegram Clásicos"),
            ("sticker8.webp", "Telegram Flame", "Telegram Clásicos"),
            ("sticker9.webp", "Telegram Joy", "Telegram Clásicos"),
        ]

        for filename, sticker_name, category in webp_stickers:
            try:
                url = tgs_base_url + filename
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=10) as response:
                    raw_data = response.read()
                    sticker, created = Sticker.objects.update_or_create(
                        name=sticker_name,
                        category=category,
                        defaults={
                            'is_animated': False,
                            'animation_type': 'webp'
                        }
                    )
                    sticker.image.save(filename, ContentFile(raw_data), save=True)
                    self.stdout.write(self.style.SUCCESS(f" [OK] {category} -> {sticker_name}"))
            except Exception as e:
                self.stdout.write(self.style.WARNING(f" [ERR] {sticker_name}: {e}"))

        # 3. Pack: Telegram Animated Emojis (HD WebP Animados Oficiales)
        animated_emojis = [
            ("Smileys", "Partying Face.webp", "Fiesta"),
            ("Smileys", "Face With Tears Of Joy.webp", "Risa Llanto"),
            ("Smileys", "Rolling On The Floor Laughing.webp", "Risa en Suelo"),
            ("Smileys", "Smiling Face With Hearts.webp", "Amor Enamorado"),
            ("Smileys", "Exploding Head.webp", "Mente Explotada"),
            ("Smileys", "Smiling Face With Sunglasses.webp", "Fachero Cool"),
            ("Smileys", "Thinking Face.webp", "Pensativo"),
            ("Smileys", "Zany Face.webp", "Locura Divertida"),
            ("Smileys", "Cat With Tears Of Joy.webp", "Gato Riendo"),
            ("Smileys", "Clown Face.webp", "Payaso"),
            ("Smileys", "Cold Face.webp", "Congelado Frío"),
            ("Symbols", "Heart On Fire.webp", "Corazón en Fuego"),
            ("Symbols", "Red Heart.webp", "Corazón Rojo"),
            ("Symbols", "Sparkling Heart.webp", "Corazón Brillante"),
            ("Symbols", "Hundred Points.webp", "Cien Puntos 100"),
            ("Symbols", "Heart With Ribbon.webp", "Regalo Corazón"),
            ("Activity", "Party Popper.webp", "Confeti Fiesta"),
            ("Activity", "Sparkles.webp", "Destellos Mágicos"),
            ("Activity", "Fireworks.webp", "Fuegos Artificiales"),
            ("Travel and Places", "Rocket.webp", "Cohete Despegue"),
            ("People", "Thumbs Up.webp", "Pulgar Aprobado"),
            ("People", "Thumbs Down.webp", "Pulgar Abajo"),
            ("People", "Clapping Hands.webp", "Aplausos Grandes"),
            ("People", "Victory Hand.webp", "Victoria y Paz"),
            ("People", "Ok Hand.webp", "Manos Ok Perfecto"),
            ("People", "Heart Hands.webp", "Manos de Amor"),
            ("People", "Waving Hand.webp", "Saludo Hola"),
        ]

        anim_base = "https://raw.githubusercontent.com/Tarikul-Islam-Anik/Telegram-Animated-Emojis/main/"

        for folder, raw_filename, display_name in animated_emojis:
            try:
                encoded_path = f"{urllib.parse.quote(folder)}/{urllib.parse.quote(raw_filename)}"
                url = anim_base + encoded_path
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=10) as response:
                    raw_data = response.read()
                    clean_local_name = f"tg_anim_{raw_filename.lower().replace(' ', '_')}"
                    sticker, created = Sticker.objects.update_or_create(
                        name=display_name,
                        category="Telegram Animated Emojis",
                        defaults={
                            'is_animated': True,
                            'animation_type': 'webp'
                        }
                    )
                    sticker.image.save(clean_local_name, ContentFile(raw_data), save=True)
                    self.stdout.write(self.style.SUCCESS(f" [OK] Telegram Animated Emojis -> {display_name}"))
            except Exception as e:
                self.stdout.write(self.style.WARNING(f" [ERR] {display_name}: {e}"))

        self.stdout.write(self.style.SUCCESS("✓ Todos los packs oficiales de stickers de Telegram han sido poblados con éxito."))
