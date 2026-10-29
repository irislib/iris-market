package to.iris.market

import android.app.Application
import java.io.File
import java.security.SecureRandom

/** Opened only by an explicit wallet action. No seed is derived from a Nostr key. */
object WalletCredentials {
    class Material(val baseDirectory: File, val owner: String, val device: String, val seed: String)
    @Synchronized fun loadOrCreate(application: Application, owner: String, device: String): Material {
        require(validHex(owner,64) && validHex(device,64)) { "This profile could not open its wallet." }
        val base=File(application.noBackupFilesDir,"market-wallets")
        val directory=File(File(base,owner),device)
        val record=SecureRecord(application)
        val name="cashu.seed.$owner.$device"
        val stored=record.get(name)
        if(stored.isNotBlank()) {
            check(validHex(stored,128)) { "The saved wallet recovery key is not valid." }
            check(directory.isDirectory || directory.mkdirs()) { "The wallet could not open." }
            return Material(base,owner,device,stored)
        }
        val walletFolder=File(directory,"cashu")
        check(listOf("seed-binding","wallet.sqlite","wallet.sqlite-wal","wallet.sqlite-shm","seed.json").none { File(walletFolder,it).exists() }) {
            "This wallet needs its recovery key. Its existing funds were preserved."
        }
        val bytes=ByteArray(64).also {SecureRandom().nextBytes(it)}
        val seed=bytes.joinToString("") {(it.toInt() and 255).toString(16).padStart(2,'0')}
        bytes.fill(0)
        record.put(name,seed)
        check(record.get(name)==seed) { "The wallet recovery key could not be saved securely." }
        check(directory.isDirectory || directory.mkdirs()) { "The wallet could not open." }
        return Material(base,owner,device,seed)
    }
    private fun validHex(value: String,count: Int)=value.length==count && value.all {it in '0'..'9' || it in 'a'..'f'}
}
