# External account deletion page draft

Google Play requires a functional web path to request deletion in addition to the in-app **Delete account and data** action. This copy is ready for the operator's website or Firebase Hosting. The project has no website/domain or support contact configured, so it is not yet an active request path; do not enter a placeholder URL in Play Console.

## Page copy

### Request deletion of a VanSathi account

You can delete your account in VanSathi under **Settings → Delete account and data**. If you no longer have the app, submit a deletion request using the contact form or monitored support address on this page.

Include the phone number used to sign in with country code, your role (parent or driver), and a contact method for the confirmation. We will verify that you control the VanSathi account before processing a request. Do not include an OTP, child home address, or precise location in the request.

Parent account deletion removes the account and phone sign-in record, removes the parent's phone and link from linked child contact records, and removes the parent's absence requests. Driver account deletion is processed after the driver ends any active trip; it removes the driver's van, children, trip history, route points, and driver approval record. Sampled route points are otherwise scheduled for deletion after 30 days. Limited platform backups or security logs may remain temporarily under provider retention.

The service operator must publish a monitored contact and a clear expected response time here before launch. Add a secure form or support email that can route a verified request to the deployed `deleteAccountData` process. A generic mailto link without a monitored inbox is not sufficient.

## Publish checklist

- Replace “service operator” with the legal/operator name shown on the Google Play listing.
- Add the active privacy policy URL and a visible deletion request form or monitored support address.
- Test the URL in a private browser session without installing or signing into the app.
- Verify the request flow authenticates the claimant and leads to the same data deletion behavior as the in-app callable.
- Enter the published URL in the Play Console account deletion field and Data safety answers.
