/// Streaming area-averaging resampler for mono audio.
///
/// Each output sample is the average of the input span it covers, which acts as
/// a cheap low-pass filter when downsampling (48 kHz or 44.1 kHz to 16 kHz).
pub struct Resampler {
    step   : f64,
    sum    : f64,
    weight : f64,
}

impl Resampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        Self {
            step   : in_rate as f64 / out_rate as f64,
            sum    : 0.0,
            weight : 0.0,
        }
    }

    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        for &sample in input {
            let x             = sample as f64;
            let mut remaining = 1.0_f64;

            loop {
                let need = self.step - self.weight;

                if remaining >= need {
                    self.sum += x * need;
                    out.push((self.sum / self.step) as f32);

                    remaining   -= need;
                    self.sum     = 0.0;
                    self.weight  = 0.0;

                    if remaining <= 1e-12 {
                        break;
                    }
                } else {
                    self.sum    += x * remaining;
                    self.weight += remaining;
                    break;
                }
            }
        }
    }
}
