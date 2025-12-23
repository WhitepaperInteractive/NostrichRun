// --------------------
// CONFIG
// --------------------
const CONFIG = {
  lnbitsNode: "https://lnbits.whitepaperinteractive.com",
  paywallId: "65CZ9aCgDfk7uHbKTvErx9",
  sats: 21,
  paywallPrefix: "/paywall"
};

// --------------------
// STATE
// --------------------
const state = {
  bolt11: null,
  paymentHash: null,
  ws: null,
  poll: null,
  nwcClient: null
};

// --------------------
// DOM HELPERS
// --------------------
const $ = (id) => document.getElementById(id);

// --------------------
// SESSION ACCESS (session only - clears on browser close)
// --------------------
function hasAccess() {
  return sessionStorage.getItem("p2p_access") === "true";
}

function showAlreadyPaidState() {
  const alreadyPaidArea = $("alreadyPaidArea");
  const needPaymentArea = $("needPaymentArea");
  
  if (alreadyPaidArea && needPaymentArea) {
    alreadyPaidArea.classList.remove("hidden");
    needPaymentArea.classList.add("hidden");
  }
}

function showNeedPaymentState() {
  const alreadyPaidArea = $("alreadyPaidArea");
  const needPaymentArea = $("needPaymentArea");
  
  if (alreadyPaidArea && needPaymentArea) {
    alreadyPaidArea.classList.add("hidden");
    needPaymentArea.classList.remove("hidden");
  }
}

function grantAccess() {
  sessionStorage.setItem("p2p_access", "true");
  $("paidArea").classList.remove("hidden");
  $("invoiceArea").classList.add("hidden");
  
  // Auto-redirect to game after payment
  window.location.href = "./game.html";
}

function revokeAccess() {
  sessionStorage.removeItem("p2p_access");
  $("paidArea").classList.add("hidden");
  showNeedPaymentState();
}

// --------------------
// PERSISTENT STORAGE (localStorage - persists across sessions)
// --------------------
function saveNostrLogin(pubkey, loginMethod) {
  localStorage.setItem("nostr_pubkey", pubkey);
  localStorage.setItem("nostr_login_method", loginMethod);
}

function getNostrLogin() {
  return localStorage.getItem("nostr_pubkey");
}

function getNostrLoginMethod() {
  return localStorage.getItem("nostr_login_method");
}

function clearNostrLogin() {
  localStorage.removeItem("nostr_pubkey");
  localStorage.removeItem("nostr_login_method");
}

function saveNWCUrl(url) {
  localStorage.setItem("nwc_url", url);
}

function getNWCUrl() {
  return localStorage.getItem("nwc_url");
}

function clearNWCUrl() {
  localStorage.removeItem("nwc_url");
}

// --------------------
// LNBits helpers
// --------------------
function http(path) {
  return `${CONFIG.lnbitsNode}${CONFIG.paywallPrefix}${path}`;
}

function ws(path) {
  return http(path).replace("https", "wss");
}

// --------------------
// Load Nostr Profile
// --------------------
async function loadNostrProfile(pubkey, loginMethod = "extension") {
  const profileName = $("nostrProfileName");
  const profilePic = $("nostrProfilePic");
  const userProfile = $("userProfile");
  
  profileName.textContent = pubkey.slice(0, 8) + "..." + pubkey.slice(-8);
  profilePic.style.display = "none";
  if (userProfile) userProfile.classList.remove("hidden");

  // Save to localStorage for persistence (pubkey and method only, NOT private keys)
  saveNostrLogin(pubkey, loginMethod);

  return new Promise((resolve) => {
    const relays = ["wss://relay.nostr.band", "wss://relay.damus.io", "wss://nos.lol"];
    let profileFound = false;
    let completedRelays = 0;

    relays.forEach((relay) => {
      const subId = Math.random().toString(36).substring(2);
      const socket = new WebSocket(relay);
      const timeout = setTimeout(() => {
        socket.close();
        completedRelays++;
        if (completedRelays === relays.length && !profileFound) {
          resolve();
        }
      }, 3000);

      socket.onopen = () => {
        const req = ["REQ", subId, {
          kinds: [0],
          authors: [pubkey]
        }];
        socket.send(JSON.stringify(req));
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data[0] === "EVENT" && data[2] && data[2].kind === 0) {
            const metadata = JSON.parse(data[2].content);
            if (metadata.name) {
              profileName.textContent = metadata.name;
              profileFound = true;
            }
            if (metadata.picture) {
              profilePic.src = metadata.picture;
              profilePic.style.display = "block";
              profileFound = true;
            }
            clearTimeout(timeout);
            socket.close();
            completedRelays++;
            if (profileFound || completedRelays === relays.length) {
              resolve();
            }
          }
        } catch (e) {
          console.warn("Error parsing profile metadata:", e);
        }
      };

      socket.onerror = () => {
        clearTimeout(timeout);
        socket.close();
        completedRelays++;
        if (completedRelays === relays.length) {
          resolve();
        }
      };

      socket.onclose = () => {
        clearTimeout(timeout);
        completedRelays++;
        if (completedRelays === relays.length) {
          resolve();
        }
      };
    });
  });
}

// --------------------
// NWC Connection Management
// --------------------
function showNWCConnected() {
  $("nwcNotConnected").classList.add("hidden");
  $("nwcConnected").classList.remove("hidden");
}

function showNWCDisconnected() {
  $("nwcNotConnected").classList.remove("hidden");
  $("nwcConnected").classList.add("hidden");
  state.nwcClient = null;
}

async function connectNWC(nwcUrl) {
  try {
    const alby = await import("https://esm.sh/@getalby/sdk@7.0.0");
    state.nwcClient = new alby.NWCClient({
      nostrWalletConnectUrl: nwcUrl
    });
    
    // Save URL for persistence
    saveNWCUrl(nwcUrl);
    showNWCConnected();
    return true;
  } catch (err) {
    console.error("NWC connection error:", err);
    alert("Failed to connect NWC wallet: " + (err.message || "Unknown error"));
    return false;
  }
}

function disconnectNWC() {
  clearNWCUrl();
  showNWCDisconnected();
  $("nwcInput").value = "";
}

// --------------------
// CREATE INVOICE
// --------------------
async function createInvoice() {
  const qrContainer = $("qr");
  const loadingIndicator = $("invoiceLoading");
  
  // Show loading indicator
  if (loadingIndicator) loadingIndicator.classList.remove("hidden");
  qrContainer.innerHTML = "";
  
  try {
    const res = await fetch(
      http(`/api/v1/paywalls/invoice/${CONFIG.paywallId}?amount=${CONFIG.sats}`)
    );
    if (!res.ok) throw new Error("Invoice failed");

    const data = await res.json();
    state.bolt11 = data.payment_request;
    state.paymentHash = data.payment_hash;

    $("invoiceText").value = state.bolt11;
    $("paymentHash").textContent = state.paymentHash;
    $("invoiceArea").classList.remove("hidden");

    // QR - Use lowercase for maximum wallet compatibility
    qrContainer.innerHTML = "";

    const invoiceData = state.bolt11.trim().toLowerCase();
    console.log("QR invoice data:", invoiceData);

    const canvas = document.createElement("canvas");
    qrContainer.appendChild(canvas);

    new QRious({
      element: canvas,
      value: invoiceData,
      size: 280,
      level: "L",
      background: "#ffffff",
      foreground: "#000000"
    });

    // Hide loading indicator
    if (loadingIndicator) loadingIndicator.classList.add("hidden");

    watchPayment();
  } catch (err) {
    if (loadingIndicator) loadingIndicator.classList.add("hidden");
    console.error("Invoice creation failed:", err);
  }
}

// --------------------
// WATCH PAYMENT
// --------------------
function watchPayment() {
  if (state.ws) state.ws.close();

  state.ws = new WebSocket(
    ws(`/api/v1/paywalls/invoice/${CONFIG.paywallId}/${state.paymentHash}`)
  );

  state.ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.paid) {
      grantAccess();
      state.ws.close();
    }
  };

  // Poll fallback
  state.poll = setInterval(async () => {
    const res = await fetch(
      http(`/api/v1/paywalls/check_invoice/${CONFIG.paywallId}`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payment_hash: state.paymentHash })
      }
    );
    const data = await res.json();
    if (data.paid) {
      clearInterval(state.poll);
      grantAccess();
    }
  }, 3000);
}

// --------------------
// PAY WITH WEBLN
// --------------------
async function payWebLN() {
  if (!window.webln) {
    alert("WebLN not detected. Please install a Lightning wallet extension like Alby.");
    return;
  }
  
  if (!state.bolt11) {
    alert("No invoice to pay. Please create an invoice first.");
    return;
  }

  const btn = $("btnPayWebLN");
  const originalText = btn.textContent;
  
  try {
    btn.textContent = "Connecting...";
    btn.disabled = true;
    
    // Enable WebLN connection
    await window.webln.enable();
    
    btn.textContent = "Sending payment...";
    
    // Send the payment
    const response = await window.webln.sendPayment(state.bolt11);
    console.log("WebLN payment response:", response);
    
    btn.textContent = "Payment sent!";
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 2000);
  } catch (err) {
    console.error("WebLN payment error:", err);
    btn.textContent = originalText;
    btn.disabled = false;
    
    if (err.message && err.message.includes("User rejected")) {
      // User cancelled, no need to alert
      return;
    }
    alert("WebLN payment failed: " + (err.message || "Unknown error"));
  }
}

// --------------------
// PAY WITH NWC
// --------------------
async function payNWC() {
  if (!state.nwcClient) {
    alert("Please connect your NWC wallet first");
    return;
  }
  
  if (!state.bolt11) {
    alert("No invoice to pay. Please create an invoice first.");
    return;
  }

  const btn = $("btnPayNWC");
  const originalText = btn.textContent;
  
  try {
    btn.textContent = "Sending payment...";
    btn.disabled = true;
    
    const response = await state.nwcClient.payInvoice({ invoice: state.bolt11 });
    console.log("Payment response:", response);
    
    btn.textContent = "Payment sent!";
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 2000);
  } catch (err) {
    console.error("NWC payment error:", err);
    btn.textContent = originalText;
    btn.disabled = false;
    alert("NWC payment failed: " + (err.message || JSON.stringify(err) || "Unknown error"));
  }
}

// --------------------
// COPY INVOICE
// --------------------
function copyInvoice() {
  if (!state.bolt11) {
    alert("No invoice to copy");
    return;
  }
  navigator.clipboard.writeText(state.bolt11).then(() => {
    const btn = $("btnCopyInvoice");
    const originalText = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => {
      btn.textContent = originalText;
    }, 2000);
  }).catch(err => {
    console.error("Copy failed:", err);
    alert("Failed to copy invoice");
  });
}

// --------------------
// RESTORE PERSISTED STATE
// --------------------
async function restorePersistedState() {
  // Restore Nostr login
  const savedPubkey = getNostrLogin();
  const savedMethod = getNostrLoginMethod();
  if (savedPubkey) {
    await loadNostrProfile(savedPubkey, savedMethod || "extension");
  }
  
  // Restore NWC connection
  const savedNWCUrl = getNWCUrl();
  if (savedNWCUrl) {
    $("nwcInput").value = savedNWCUrl;
    await connectNWC(savedNWCUrl);
  }
}

// --------------------
// BUTTON WIRING
// --------------------
function wire() {
  $("btnCreateInvoice").onclick = createInvoice;
  $("btnPayNWC").onclick = payNWC;
  if ($("btnPayWebLN")) $("btnPayWebLN").onclick = payWebLN;
  $("btnCopyInvoice").onclick = copyInvoice;
  $("btnLock").onclick = revokeAccess;

  // NWC Connect/Disconnect
  $("btnConnectNWC").onclick = async () => {
    const nwcUrl = $("nwcInput").value.trim();
    if (!nwcUrl) {
      alert("Please enter your NWC connection string");
      return;
    }
    
    const btn = $("btnConnectNWC");
    btn.textContent = "Connecting...";
    btn.disabled = true;
    
    const success = await connectNWC(nwcUrl);
    
    btn.textContent = "Connect";
    btn.disabled = false;
  };
  
  $("btnDisconnectNWC").onclick = disconnectNWC;

  // Wallet Toggle Tabs
  $("tabWebLN").onclick = () => {
    $("tabWebLN").classList.add("active");
    $("tabNWC").classList.remove("active");
    $("weblnPanel").classList.remove("hidden");
    $("nwcPanel").classList.add("hidden");
  };
  
  $("tabNWC").onclick = () => {
    $("tabNWC").classList.add("active");
    $("tabWebLN").classList.remove("active");
    $("nwcPanel").classList.remove("hidden");
    $("weblnPanel").classList.add("hidden");
  };

  // Nostr Extension Login (NIP-07 - most secure)
  $("btnNip07").onclick = async () => {
    if (!window.nostr) return alert("Nostr extension not detected");
    try {
      const pubkey = await window.nostr.getPublicKey();
      await loadNostrProfile(pubkey, "extension");
    } catch (err) {
      alert("Failed to connect: " + err.message);
    }
  };

  // NSEC Login (stores pubkey only, not the private key)
  $("btnNsec").onclick = async () => {
    const nsec = $("nsecInput").value.trim();
    if (!nsec || !nsec.startsWith("nsec")) {
      alert("Please enter a valid NSEC key");
      return;
    }

    try {
      const { decode } = await import("https://esm.sh/nostr-tools@2.7.0/nip19");
      const { getPublicKey } = await import("https://esm.sh/nostr-tools@2.7.0/pure");
      const { bytesToHex } = await import("https://esm.sh/@noble/hashes@1.3.3/utils");

      const decoded = decode(nsec);
      if (decoded.type !== "nsec") throw new Error("Invalid nsec");

      const privateKeyBytes = decoded.data;
      const pubkeyBytes = getPublicKey(privateKeyBytes);
      
      // Ensure we have a hex string for the relay query
      const pubkeyHex = typeof pubkeyBytes === 'string' ? pubkeyBytes : bytesToHex(pubkeyBytes);
      
      // Only save pubkey, NOT the private key for security
      await loadNostrProfile(pubkeyHex, "nsec");
      
      // Clear the nsec input for security
      $("nsecInput").value = "";
    } catch (err) {
      alert("Invalid NSEC key: " + err.message);
    }
  };

  $("btnNsecClear").onclick = () => {
    $("nsecInput").value = "";
  };

  // Nsec visibility toggle
  $("toggleNsec").onclick = () => {
    const input = $("nsecInput");
    const eyeOpen = $("eyeOpen");
    const eyeClosed = $("eyeClosed");
    
    if (input.type === "password") {
      input.type = "text";
      eyeOpen.classList.add("hidden");
      eyeClosed.classList.remove("hidden");
    } else {
      input.type = "password";
      eyeOpen.classList.remove("hidden");
      eyeClosed.classList.add("hidden");
    }
  };

  // Bunker Login
  $("btnBunker").onclick = async () => {
    const url = $("bunkerInput").value.trim();
    if (!url.startsWith("bunker://")) {
      alert("Invalid Bunker URL");
      return;
    }

    const match = url.match(/^bunker:\/\/([^?]+)/);
    if (match) {
      const pubkey = match[1];
      loadNostrProfile(pubkey, "bunker");
    } else {
      alert("Could not parse pubkey from Bunker URL");
    }
  };

  $("btnBunkerDisconnect").onclick = () => {
    $("bunkerInput").value = "";
  };

  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".tabPanel").forEach(p => p.classList.remove("active"));

      tab.classList.add("active");
      const targetId = "tab-" + tab.dataset.tab;
      const panel = document.getElementById(targetId);
      if (panel) panel.classList.add("active");
    });
  });

  // Logout - only clears NOSTR login, NOT payment token
  $("btnLogout").onclick = () => {
    clearNostrLogin();

    $("nostrProfileName").textContent = "";
    $("nostrProfilePic").style.display = "none";
    const userProfile = $("userProfile");
    if (userProfile) userProfile.classList.add("hidden");

    $("nsecInput").value = "";
    $("bunkerInput").value = "";
  };

  // Create invoice on load if not already paid
  if (!hasAccess()) createInvoice();
}

// --------------------
// INIT
// --------------------
wire();
restorePersistedState();

// Check session access state on page load
if (hasAccess()) {
  // User already has access (coming back from game) - show enter game option
  showAlreadyPaidState();
} else {
  // User needs to pay - show payment options
  showNeedPaymentState();
}
