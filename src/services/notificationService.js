// No external dependencies for now

/**
 * A service to handle sending SMS / WhatsApp notifications to tenants.
 * This can be wired up to Twilio, Gupshup, Interakt, or any Fast2SMS local API.
 */
class NotificationService {
  /**
   * Send a WhatsApp or SMS notification about a newly generated bill.
   * 
   * @param {Object} tenant - The tenant user object containing mobile and name.
   * @param {Object} statement - The generated bill statement object.
   */
  static async sendBillDueNotification(tenant, statement) {
    try {
      if (!tenant || !tenant.mobile) {
        console.warn('NotificationService: Cannot send notification, tenant mobile missing.');
        return false;
      }

      const mobile = tenant.mobile;
      const amount = statement.total;
      const dueDate = statement.due_date;
      const period = statement.period;
      const invoiceNo = statement.invoice_no;

      const message = `Hello ${tenant.name}, your rent/electricity bill for ${period} has been generated. Invoice No: ${invoiceNo}. Total Due: ₹${amount}. Please pay by ${dueDate} to avoid late fees or disconnection. Thank you!`;

      // ----------------------------------------------------------------------
      // TODO: IMPLEMENT ACTUAL SMS/WHATSAPP PROVIDER HERE
      // ----------------------------------------------------------------------
      // Example for Twilio:
      // await twilioClient.messages.create({ body: message, from: '+12345', to: mobile });
      
      // Example for a Generic HTTP API (like Fast2SMS / Interakt):
      // await axios.post('https://api.your-sms-provider.com/send', {
      //   to: mobile,
      //   text: message,
      // }, { headers: { Authorization: \`Bearer YOUR_API_KEY\` }});
      
      console.log('====================================================');
      console.log(`[NOTIFICATION SENT] To: ${mobile}`);
      console.log(`[MESSAGE]: ${message}`);
      console.log('====================================================');

      return true;
    } catch (error) {
      console.error('NotificationService Error:', error.message);
      return false;
    }
  }
}

module.exports = NotificationService;
