package com.ellie.app.data

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.ByteBuffer
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Encrypts the control-plane bearer token with a non-exportable Android Keystore key. */
class ControlPlaneSecretStore {
    companion object {
        private const val KEY_ALIAS = "ellie_control_plane_token_v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128
    }

    private val keyStore: KeyStore by lazy {
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    }

    private fun key(): SecretKey {
        val existing = keyStore.getKey(KEY_ALIAS, null) as? SecretKey
        if (existing != null) return existing

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return generator.generateKey()
    }

    fun encrypt(plainText: String): String {
        if (plainText.isBlank()) return ""
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val ciphertext = cipher.doFinal(plainText.toByteArray(Charsets.UTF_8))
        val packed = ByteBuffer.allocate(Int.SIZE_BYTES + cipher.iv.size + ciphertext.size)
            .putInt(cipher.iv.size)
            .put(cipher.iv)
            .put(ciphertext)
            .array()
        return Base64.encodeToString(packed, Base64.NO_WRAP)
    }

    fun decrypt(encoded: String): String {
        if (encoded.isBlank()) return ""
        return try {
            val packed = Base64.decode(encoded, Base64.NO_WRAP)
            val buffer = ByteBuffer.wrap(packed)
            val ivLength = buffer.int
            if (ivLength <= 0 || ivLength > 32 || buffer.remaining() <= ivLength) return ""
            val iv = ByteArray(ivLength).also { buffer.get(it) }
            val ciphertext = ByteArray(buffer.remaining()).also { buffer.get(it) }
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, iv))
            cipher.doFinal(ciphertext).toString(Charsets.UTF_8)
        } catch (_: Exception) {
            ""
        }
    }
}
