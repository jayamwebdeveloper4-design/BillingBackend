const ProjectClient = require("../Models/ProjectClient");

function toStringArray(value, lowercase = false) {
    const values = Array.isArray(value) ? value : [value];

    return [
        ...new Set(
            values
                .flatMap((item) => String(item || "").split(","))
                .map((item) => {
                    const cleaned = item.trim();
                    return lowercase ? cleaned.toLowerCase() : cleaned;
                })
                .filter(Boolean)
        ),
    ];
}

async function syncProjectClient(billingCustomer) {
    return ProjectClient.findOneAndUpdate(
        { billingCustomerId: billingCustomer._id },
        {
            $set: {
                clientName: billingCustomer.name,
                phone: toStringArray(billingCustomer.phone),
                email: toStringArray(billingCustomer.email, true),
                country: billingCustomer.country || "",
                state: billingCustomer.state || "",
                gstin: billingCustomer.gstin || "",
                address: billingCustomer.address || "",
                contactPerson: billingCustomer.contactPerson || "",
                notes: billingCustomer.notes || "",
            },
            $setOnInsert: {
                billingCustomerId: billingCustomer._id,
            },
        },
        {
            upsert: true,
            new: true,
            runValidators: true,
            setDefaultsOnInsert: true,
        }
    );
}

module.exports = syncProjectClient;