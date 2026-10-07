# paperclip-watchdog (Türkçe)

**Siz yokken [Paperclip](https://github.com/paperclipai/paperclip) şirketiniz durmasın.**

Ajanlar sıkıcı sebeplerle takılır: kartı cevapladınız ama ajanı uyandıran olmadı, beklediği görev saatler önce bitti, CI bitti (ya da PR çakıştığı için hiç başlamayacak), oturum bozuldu ve her çalışma zaman aşımına düşüyor. Sabah bakarsınız, hiçbir şey ilerlememiş.

`paperclip-watchdog` her dakika Paperclip'e bakar, **mekanik** bir sebeple takılan işleri bulup yürütür; insan gerektiren bir durum varsa size haber verir. Model token'ı harcamaz, bağımlılığı yoktur, her işlemi görev başına sınırlıdır ve yorumla imzalar. `--dry-run` hiçbir şey değiştirmeden ne yapacağını gösterir.

Kurulum ve bekçilerin listesi için [README.md](README.md). Onay ve soruları telefondan cevaplamak için: [paperclip-telegram](https://github.com/iosayin/paperclip-telegram).

Kurulumsuz çalıştırma: `npx paperclip-watchdog --dry-run` sonra `npx paperclip-watchdog`. npm: https://www.npmjs.com/package/paperclip-watchdog
