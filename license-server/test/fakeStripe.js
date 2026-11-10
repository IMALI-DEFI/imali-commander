// In-memory stand-in for the parts of the Stripe SDK the license service uses.
const missing = what => Object.assign(new Error(`No such ${what}`), { code: 'resource_missing', statusCode: 404 });

export const WEBHOOK_SIGNATURE = 'test-signature';

export function fakeStripe() {
  const subs = new Map();
  const sessions = new Map();
  const stripe = {
    created: [],
    subs,
    checkout: {
      sessions: {
        create: async params => {
          stripe.created.push(params);
          return { id: 'cs_test_newsession0001', url: 'https://checkout.stripe.test/pay/cs_test_newsession0001' };
        },
        retrieve: async (id, opts = {}) => {
          const s = sessions.get(id);
          if (!s) throw missing('checkout session');
          return { ...s, subscription: opts.expand?.includes('subscription') ? subs.get(s.subscription) || null : s.subscription };
        },
      },
    },
    subscriptions: {
      retrieve: async id => {
        if (stripe.down) throw new Error('Stripe unreachable');
        const s = subs.get(id);
        if (!s) throw missing('subscription');
        return s;
      },
    },
    billingPortal: {
      sessions: { create: async ({ customer }) => ({ url: `https://billing.stripe.test/session/${customer}` }) },
    },
    webhooks: {
      constructEvent: (raw, signature) => {
        if (signature !== WEBHOOK_SIGNATURE) throw new Error('No signatures found matching the expected signature');
        return JSON.parse(raw.toString('utf8'));
      },
    },
    // Test helper: a completed Commander Pro checkout.
    addCheckout(id, { status = 'complete', subStatus = 'active', plan = 'monthly', email = 'buyer@example.com', product = 'imali_commander_pro' } = {}) {
      const subId = `sub_${id.slice(-8)}`;
      subs.set(subId, { id: subId, status: subStatus, metadata: { product, plan } });
      sessions.set(id, {
        id, mode: 'subscription', status, payment_status: status === 'complete' ? 'paid' : 'unpaid',
        customer: `cus_${id.slice(-6)}`, customer_details: { email },
        metadata: { app: 'imali_commander', product, plan }, subscription: subId,
      });
      return subId;
    },
  };
  return stripe;
}
