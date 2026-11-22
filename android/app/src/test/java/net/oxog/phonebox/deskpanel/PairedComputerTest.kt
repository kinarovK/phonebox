package net.oxog.phonebox.deskpanel

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class PairedComputerTest {
    private fun storedComputer(): JSONObject = JSONObject().put("id", "fp").put("name", "Desk")
        .put("hosts", JSONArray(listOf("192.168.1.5"))).put("port", 8766).put("token", "t")

    // Versions with Wake-on-LAN also stored the computer's MAC addresses; such an entry still loads, and they are dropped.
    @Test
    fun aComputerStoredWithMacsByAnOlderVersionStillLoads() {
        val pc = AgentLink.Pc.from(storedComputer().put("macs", JSONArray(listOf("AA:BB:CC:DD:EE:01"))))
        assertEquals("Desk", pc.name)
        assertEquals(listOf("192.168.1.5"), pc.hosts)
        assertFalse(pc.json().has("macs"))
    }

    @Test
    fun aComputerSurvivesASaveAndLoad() {
        val pc = AgentLink.Pc("fp", "Desk", listOf("192.168.1.5"), 8766, "t")
        val back = AgentLink.Pc.from(pc.json())
        assertEquals(listOf(pc.id, pc.name, pc.port, pc.token), listOf(back.id, back.name, back.port, back.token))
        assertEquals(pc.hosts, back.hosts)
    }
}
